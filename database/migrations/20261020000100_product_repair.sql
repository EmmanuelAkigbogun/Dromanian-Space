-- Product repair: canonical channel enrollment and server-owned call writes.

CREATE OR REPLACE FUNCTION public.enroll_member_in_default_channels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  INSERT INTO public.channel_members (channel_id, user_id, role)
  SELECT c.id, NEW.user_id, CASE WHEN NEW.role = 'owner' THEN 'owner' ELSE 'member' END
  FROM public.workspace_settings s
  CROSS JOIN LATERAL unnest(coalesce(s.default_channel_ids, '{}'::uuid[])) AS configured(channel_id)
  JOIN public.channels c ON c.id = configured.channel_id AND c.workspace_id = NEW.workspace_id
  WHERE s.workspace_id = NEW.workspace_id
  ON CONFLICT (channel_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enroll_member_in_default_channels() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_workspace_member_default_channels ON public.workspace_members;
CREATE TRIGGER trg_workspace_member_default_channels
  AFTER INSERT ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.enroll_member_in_default_channels();

CREATE OR REPLACE FUNCTION public.create_workspace_with_owner(
  p_name text, p_slug text, p_owner_id uuid, p_description text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_workspace_id uuid;
  v_channel_id uuid;
  v_workspace json;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_owner_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'A workspace can only be created for yourself' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_name), '') = '' OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'Workspace name is required (max 120 characters)' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.workspaces (name, slug, description, owner_id)
  VALUES (btrim(p_name), p_slug, p_description, v_uid)
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.channels (workspace_id, name, slug, description, type, is_private, created_by)
  VALUES (v_workspace_id, 'General', 'general', 'Company-wide conversations and announcements', 'text', false, v_uid)
  RETURNING id INTO v_channel_id;

  INSERT INTO public.workspace_settings (workspace_id, default_channel_ids, updated_by)
  VALUES (v_workspace_id, ARRAY[v_channel_id], v_uid);

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, v_uid, 'owner');

  SELECT row_to_json(w.*) INTO v_workspace FROM public.workspaces w WHERE w.id = v_workspace_id;
  RETURN v_workspace;
END;
$$;

REVOKE ALL ON FUNCTION public.create_workspace_with_owner(text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_workspace_with_owner(text, text, uuid, text) TO authenticated;

-- Idempotent backfill: make every existing #general canonical and enroll every
-- workspace member. This repairs Digital Romanian without hard-coding row IDs.
INSERT INTO public.workspace_settings (workspace_id, default_channel_ids, updated_at)
SELECT c.workspace_id, ARRAY[c.id], now()
FROM public.channels c
WHERE c.slug = 'general' AND c.archived_at IS NULL
ON CONFLICT (workspace_id) DO UPDATE
SET default_channel_ids = CASE
      WHEN EXCLUDED.default_channel_ids[1] = ANY(coalesce(workspace_settings.default_channel_ids, '{}'::uuid[]))
        THEN workspace_settings.default_channel_ids
      ELSE array_append(coalesce(workspace_settings.default_channel_ids, '{}'::uuid[]), EXCLUDED.default_channel_ids[1])
    END,
    updated_at = now();

INSERT INTO public.channel_members (channel_id, user_id, role)
SELECT c.id, wm.user_id, CASE WHEN wm.role = 'owner' THEN 'owner' ELSE 'member' END
FROM public.channels c
JOIN public.workspace_members wm ON wm.workspace_id = c.workspace_id
WHERE c.slug = 'general' AND c.archived_at IS NULL
ON CONFLICT (channel_id, user_id) DO NOTHING;

ALTER TABLE public.call_signaling ADD COLUMN IF NOT EXISTS client_message_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_signaling_sender_message
  ON public.call_signaling(call_id, from_user_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_sessions_stale_ringing
  ON public.call_sessions(created_at) WHERE status = 'ringing';

-- Call mutation now belongs to the same-origin API, which validates every
-- participant. Browsers retain read-only RLS access for history rendering.
DROP POLICY IF EXISTS "call_sessions_insert_auth" ON public.call_sessions;
DROP POLICY IF EXISTS "call_sessions_update_creator" ON public.call_sessions;
DROP POLICY IF EXISTS "call_sessions_delete_creator" ON public.call_sessions;
DROP POLICY IF EXISTS "call_participants_insert" ON public.call_participants;
DROP POLICY IF EXISTS "call_participants_update" ON public.call_participants;
DROP POLICY IF EXISTS "call_participants_delete_self" ON public.call_participants;
DROP POLICY IF EXISTS "call_signaling_insert" ON public.call_signaling;
DROP POLICY IF EXISTS "call_signaling_delete" ON public.call_signaling;

REVOKE INSERT, UPDATE, DELETE ON public.call_sessions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.call_participants FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.call_signaling FROM authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_stale_calls()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_missed integer; v_signals integer;
BEGIN
  UPDATE public.call_sessions
  SET status = 'missed', ended_at = now(), duration = 0
  WHERE status = 'ringing' AND created_at < now() - interval '60 seconds';
  GET DIAGNOSTICS v_missed = ROW_COUNT;

  UPDATE public.call_participants cp
  SET status = CASE WHEN cp.status IN ('invited', 'ringing') THEN 'disconnected' ELSE cp.status END,
      left_at = coalesce(cp.left_at, now())
  FROM public.call_sessions cs
  WHERE cs.id = cp.call_id AND cs.status IN ('ended', 'missed', 'declined', 'cancelled')
    AND cp.status IN ('invited', 'ringing', 'connected');

  DELETE FROM public.call_signaling WHERE created_at < now() - interval '1 hour';
  GET DIAGNOSTICS v_signals = ROW_COUNT;
  RETURN jsonb_build_object('missed_calls', v_missed, 'expired_signals', v_signals);
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_stale_calls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_calls() TO service_role;

CREATE OR REPLACE FUNCTION public.maintenance_tasks()
RETURNS TABLE(task text, cron_job text, fn text)
LANGUAGE sql IMMUTABLE AS $$
  VALUES
    ('scheduled_messages', 'send-due-scheduled-messages', 'send_due_scheduled_messages'),
    ('expired_drafts', 'expire-stale-scheduled-drafts', 'expire_stale_scheduled_drafts'),
    ('recovered_runs', 'agent-recover-stale-runs', 'agent_recover_stale_runs'),
    ('abandoned_uploads', 'drive-cleanup-abandoned-uploads', 'drive_cleanup_abandoned_uploads'),
    ('stale_calls', 'calls-cleanup-stale', 'cleanup_stale_calls'),
    ('reminders', 'send-due-reminders', 'send_due_reminders'),
    ('calendar_reminders', 'automation-calendar-reminders', 'fire_calendar_event_reminders'),
    ('calendar_started', 'automation-calendar-started', 'fire_calendar_event_started');
$$;

NOTIFY pgrst, 'reload schema';
