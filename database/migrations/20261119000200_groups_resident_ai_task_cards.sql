-- Group chats you can manage, an AI that stays in a group and posts a daily
-- summary, and the AI's proposed tasks shown as cards inside the chat.

-- ── Group management (direct-message groups) ───────────────────────────────
-- The group's owner (its creator) or a workspace admin manages it. The group's
-- channel membership is kept in step with its participant list.

CREATE OR REPLACE FUNCTION public.dm_group_can_manage(p_conversation_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.direct_conversations conversation
    WHERE conversation.id = p_conversation_id
      AND conversation.type = 'group'
      AND public.user_is_workspace_member(conversation.workspace_id, p_actor)
      AND (conversation.created_by = p_actor
           OR public.user_is_workspace_admin(conversation.workspace_id, p_actor))
  );
$$;

CREATE OR REPLACE FUNCTION public.dm_group_rename(p_conversation_id uuid, p_name text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  clean text := btrim(coalesce(p_name, ''));
  target_channel uuid;
BEGIN
  IF NOT public.dm_group_can_manage(p_conversation_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only the group owner or a workspace admin can rename this group' USING ERRCODE = '42501';
  END IF;
  IF length(clean) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Use a group name of 1 to 80 characters' USING ERRCODE = '22023';
  END IF;
  UPDATE public.direct_conversations SET name = clean, updated_at = now()
  WHERE id = p_conversation_id
  RETURNING channel_id INTO target_channel;
  UPDATE public.channels SET name = clean WHERE id = target_channel;
END $$;

CREATE OR REPLACE FUNCTION public.dm_group_add_members(p_conversation_id uuid, p_user_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  conversation public.direct_conversations%ROWTYPE;
  added integer := 0;
  person uuid;
BEGIN
  IF NOT public.dm_group_can_manage(p_conversation_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only the group owner or a workspace admin can add people' USING ERRCODE = '42501';
  END IF;
  IF coalesce(cardinality(p_user_ids), 0) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Add between 1 and 50 people at a time' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO conversation FROM public.direct_conversations WHERE id = p_conversation_id;
  FOREACH person IN ARRAY p_user_ids LOOP
    IF NOT public.user_is_workspace_member(conversation.workspace_id, person) THEN
      RAISE EXCEPTION 'Everyone you add must be a member of this workspace' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.direct_conversation_participants (conversation_id, user_id)
    VALUES (p_conversation_id, person)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
    IF FOUND THEN added := added + 1; END IF;
    INSERT INTO public.channel_members (channel_id, user_id)
    VALUES (conversation.channel_id, person)
    ON CONFLICT (channel_id, user_id) DO NOTHING;
  END LOOP;
  UPDATE public.direct_conversations SET updated_at = now() WHERE id = p_conversation_id;
  RETURN added;
END $$;

CREATE OR REPLACE FUNCTION public.dm_group_remove_member(p_conversation_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  conversation public.direct_conversations%ROWTYPE;
BEGIN
  IF NOT public.dm_group_can_manage(p_conversation_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only the group owner or a workspace admin can remove people' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO conversation FROM public.direct_conversations WHERE id = p_conversation_id;
  IF p_user_id = conversation.created_by THEN
    RAISE EXCEPTION 'The group owner can leave the group but cannot be removed' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.direct_conversation_participants WHERE conversation_id = p_conversation_id AND user_id = p_user_id;
  DELETE FROM public.channel_members WHERE channel_id = conversation.channel_id AND user_id = p_user_id;
END $$;

-- Deletes the group with its messages, files' references and AI sessions.
CREATE OR REPLACE FUNCTION public.dm_group_delete(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  conversation public.direct_conversations%ROWTYPE;
BEGIN
  IF NOT public.dm_group_can_manage(p_conversation_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only the group owner or a workspace admin can delete this group' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO conversation FROM public.direct_conversations WHERE id = p_conversation_id;
  DELETE FROM public.crm_links WHERE channel_id = conversation.channel_id;
  DELETE FROM public.channels WHERE id = conversation.channel_id;
  DELETE FROM public.direct_conversations WHERE id = p_conversation_id;
END $$;

-- Leaving hands ownership to the longest-standing member; the last one out
-- deletes the group.
CREATE OR REPLACE FUNCTION public.dm_group_leave(p_conversation_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  actor uuid := auth.uid();
  conversation public.direct_conversations%ROWTYPE;
  successor uuid;
BEGIN
  SELECT * INTO conversation FROM public.direct_conversations
  WHERE id = p_conversation_id AND type = 'group' FOR UPDATE;
  IF conversation.id IS NULL OR NOT public.user_is_dm_participant(p_conversation_id, actor) THEN
    RAISE EXCEPTION 'Group not found' USING ERRCODE = '42501';
  END IF;
  SELECT participant.user_id INTO successor
  FROM public.direct_conversation_participants participant
  WHERE participant.conversation_id = p_conversation_id AND participant.user_id <> actor
  ORDER BY participant.created_at, participant.id
  LIMIT 1;
  IF successor IS NULL THEN
    DELETE FROM public.crm_links WHERE channel_id = conversation.channel_id;
    DELETE FROM public.channels WHERE id = conversation.channel_id;
    DELETE FROM public.direct_conversations WHERE id = p_conversation_id;
    RETURN 'deleted';
  END IF;
  IF conversation.created_by = actor THEN
    UPDATE public.direct_conversations SET created_by = successor, updated_at = now() WHERE id = p_conversation_id;
  END IF;
  -- A permanent AI keeps running under someone who is still in the group.
  UPDATE public.channel_ai_residents SET enabled_by = successor
  WHERE channel_id = conversation.channel_id AND enabled_by = actor;
  DELETE FROM public.direct_conversation_participants WHERE conversation_id = p_conversation_id AND user_id = actor;
  DELETE FROM public.channel_members WHERE channel_id = conversation.channel_id AND user_id = actor;
  RETURN 'left';
END $$;

-- ── A permanent AI member with a daily summary ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.channel_ai_residents (
  channel_id uuid PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Daily runs are requested on this member's behalf.
  enabled_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  summary_time time NOT NULL DEFAULT '18:00',
  timezone text NOT NULL DEFAULT 'Europe/Bucharest',
  last_summary_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.channel_ai_residents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_ai_residents_read ON public.channel_ai_residents;
CREATE POLICY channel_ai_residents_read ON public.channel_ai_residents FOR SELECT TO authenticated
  USING (public.user_is_channel_member(channel_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.channel_ai_residents FROM anon, authenticated;
GRANT SELECT ON public.channel_ai_residents TO authenticated;

-- Turn the permanent AI on or off. Groups: their owner or a workspace admin;
-- #general: its creator or a workspace admin.
CREATE OR REPLACE FUNCTION public.ai_resident_set(
  p_channel_id uuid,
  p_enabled boolean,
  p_summary_time time DEFAULT '18:00',
  p_timezone text DEFAULT 'Europe/Bucharest'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  actor uuid := auth.uid();
  target public.channels%ROWTYPE;
  conversation_id uuid;
  local_now timestamp;
  saved public.channel_ai_residents%ROWTYPE;
BEGIN
  SELECT * INTO target FROM public.channels WHERE id = p_channel_id AND archived_at IS NULL;
  IF target.id IS NULL OR NOT public.user_is_channel_member(p_channel_id, actor) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;
  SELECT conversation.id INTO conversation_id FROM public.direct_conversations conversation WHERE conversation.channel_id = p_channel_id;
  IF conversation_id IS NOT NULL THEN
    IF NOT public.dm_group_can_manage(conversation_id, actor) THEN
      RAISE EXCEPTION 'Only the group owner or a workspace admin can change the permanent AI' USING ERRCODE = '42501';
    END IF;
  ELSIF target.slug = 'general' THEN
    IF NOT (target.created_by = actor OR public.user_is_workspace_admin(target.workspace_id, actor)) THEN
      RAISE EXCEPTION 'Only the channel creator or a workspace admin can change the permanent AI' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'A permanent AI is available in groups and #general' USING ERRCODE = '22023';
  END IF;

  IF NOT coalesce(p_enabled, false) THEN
    DELETE FROM public.channel_ai_residents WHERE channel_id = p_channel_id;
    RETURN jsonb_build_object('enabled', false);
  END IF;

  local_now := now() AT TIME ZONE p_timezone;  -- rejects an unknown time zone
  INSERT INTO public.channel_ai_residents (channel_id, workspace_id, enabled_by, summary_time, timezone, last_summary_on)
  VALUES (
    p_channel_id, target.workspace_id, actor, p_summary_time, p_timezone,
    -- Switched on after today's summary time: the first summary is tomorrow.
    CASE WHEN local_now::time >= p_summary_time THEN local_now::date END
  )
  ON CONFLICT (channel_id) DO UPDATE
    SET enabled_by = excluded.enabled_by, summary_time = excluded.summary_time, timezone = excluded.timezone
  RETURNING * INTO saved;

  -- The AI joins now: an open notes session that the daily rollover renews.
  PERFORM public.ai_session_start(actor, p_channel_id, NULL);
  RETURN to_jsonb(saved) || jsonb_build_object('enabled', true);
END $$;

-- Claims the conversations whose summary time has come today (worker only).
CREATE OR REPLACE FUNCTION public.ai_resident_claim_due()
RETURNS TABLE (channel_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  UPDATE public.channel_ai_residents resident
  SET last_summary_on = (now() AT TIME ZONE resident.timezone)::date
  WHERE (now() AT TIME ZONE resident.timezone)::time >= resident.summary_time
    AND (resident.last_summary_on IS NULL
         OR resident.last_summary_on < (now() AT TIME ZONE resident.timezone)::date)
  RETURNING resident.channel_id;
$$;

-- Closes the day's session for its summary and opens the next one, so the AI
-- never leaves. A quiet day keeps the session open (worker only).
CREATE OR REPLACE FUNCTION public.ai_resident_rollover(p_channel_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  resident public.channel_ai_residents%ROWTYPE;
  session public.conversation_ai_sessions%ROWTYPE;
  fresh public.conversation_ai_sessions%ROWTYPE;
  human_messages integer;
BEGIN
  SELECT * INTO resident FROM public.channel_ai_residents WHERE channel_id = p_channel_id FOR UPDATE;
  IF resident.channel_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_resident');
  END IF;
  IF NOT public.user_is_channel_member(p_channel_id, resident.enabled_by) THEN
    RETURN jsonb_build_object('status', 'requester_left');
  END IF;

  SELECT * INTO session FROM public.conversation_ai_sessions
  WHERE channel_id = p_channel_id AND status = 'active'
  FOR UPDATE;
  IF session.id IS NULL THEN
    fresh := public.ai_session_start(resident.enabled_by, p_channel_id, NULL);
    RETURN jsonb_build_object('status', 'started', 'session_id', fresh.id);
  END IF;

  SELECT count(*)::integer INTO human_messages
  FROM public.messages message
  WHERE message.channel_id = p_channel_id
    AND message.deleted_at IS NULL
    AND message.agent_id IS NULL
    AND message.created_at >= session.started_at
    AND message.created_at <= now();
  IF human_messages = 0 THEN
    RETURN jsonb_build_object('status', 'quiet', 'session_id', session.id);
  END IF;

  -- Reserve the final notes as if a participant had finished the session;
  -- the scheduled summary needs no interactive review.
  UPDATE public.conversation_ai_sessions
  SET status = 'finished',
      ended_by = resident.enabled_by,
      ended_at = now(),
      message_count = human_messages,
      notes_run_id = NULL,
      notes_requested_by = resident.enabled_by,
      notes_status = 'reserving',
      notes_attempt = notes_attempt + 1
  WHERE id = session.id
  RETURNING * INTO session;

  fresh := public.ai_session_start(resident.enabled_by, p_channel_id, NULL);
  RETURN jsonb_build_object(
    'status', 'summarize',
    'session_id', session.id,
    'actor', resident.enabled_by,
    'attempt', session.notes_attempt,
    'next_session_id', fresh.id
  );
END $$;

-- ── The AI's proposed tasks, as cards in the chat ──────────────────────────
-- Task requests are private to their submitter and approvers; the group sees
-- the ones that came from its own conversation, which the AI already listed
-- in its message there.
CREATE OR REPLACE FUNCTION public.chat_task_cards(p_channel_id uuid)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  priority text,
  due_date timestamptz,
  assignee_ids uuid[],
  status text,
  task_id uuid,
  agent_run_id uuid,
  created_at timestamptz,
  decided_at timestamptz,
  can_decide boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT request.id, request.title, request.description, request.priority, request.due_date,
         request.assignee_ids, request.status, request.task_id, request.agent_run_id,
         request.created_at, request.decided_at,
         request.status = 'pending' AND public.is_task_approver(request.workspace_id, auth.uid())
  FROM public.task_requests request
  WHERE request.source_channel_id = p_channel_id
    AND public.user_is_channel_member(p_channel_id, auth.uid())
  ORDER BY request.created_at DESC
  LIMIT 300;
$$;

REVOKE ALL ON FUNCTION public.dm_group_can_manage(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dm_group_rename(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dm_group_add_members(uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dm_group_remove_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dm_group_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dm_group_leave(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_resident_set(uuid, boolean, time, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_task_cards(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dm_group_can_manage(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dm_group_rename(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dm_group_add_members(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dm_group_remove_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dm_group_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dm_group_leave(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_resident_set(uuid, boolean, time, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_task_cards(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.ai_resident_claim_due() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_resident_rollover(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_resident_claim_due() TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_resident_rollover(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
