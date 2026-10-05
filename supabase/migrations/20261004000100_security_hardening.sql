-- ============================================================================
-- 20261004000100_security_hardening.sql
-- ----------------------------------------------------------------------------
-- Closes the cross-tenant and impersonation gaps found in the legacy schema
-- (docs/IMPLEMENTATION_STATUS.md section 1). Additive and idempotent: functions
-- keep their names and argument lists so the existing client keeps working,
-- but identity now comes from auth.uid() and every operation checks
-- membership/ownership explicitly.
--
-- Highlights
--   * Internal engine functions are no longer callable by clients.
--   * Storage: message-attachments objects are readable only by their uploader
--     or by someone who can see a row that references them.
--   * RLS: message edits, DM metadata, private channel membership,
--     notifications, task activity, membership writes.
--   * Workspace-scoping triggers always derive workspace_id from the parent.
--   * Removing a workspace member removes their channel, DM and project
--     memberships in that workspace.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Membership helpers: channel membership now also requires an active
--    workspace membership, so stale channel_members rows grant nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_is_channel_member(p_channel_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM channel_members cm
    JOIN channels c ON c.id = cm.channel_id
    JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id
    WHERE cm.channel_id = p_channel_id AND cm.user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.channel_workspace_id(p_channel_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$ SELECT workspace_id FROM channels WHERE id = p_channel_id $$;

CREATE OR REPLACE FUNCTION public.user_is_dm_participant(p_conversation_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM direct_conversation_participants p
    JOIN direct_conversations dc ON dc.id = p.conversation_id
    JOIN workspace_members wm ON wm.workspace_id = dc.workspace_id AND wm.user_id = p.user_id
    WHERE p.conversation_id = p_conversation_id AND p.user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.user_role_in_workspace(p_workspace_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$ SELECT role FROM workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_user_id $$;

-- Pin search_path on every existing SECURITY DEFINER function that lacks one.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND p.proconfig IS NULL
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', r.sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Internal engine functions: server/cron only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'evaluate_automation_rules', 'automation_execute_action', 'automation_resolve_dm',
        'automation_resolve_actor', 'automation_eval_condition', 'automation_next_status',
        'send_due_scheduled_messages', 'send_due_reminders', 'fire_calendar_event_reminders',
        'fire_calendar_event_started', 'apply_message_retention'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Workspace and membership RPCs: identity from auth.uid().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_workspace_with_owner(
  p_name text, p_slug text, p_owner_id uuid, p_description text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_workspace_id uuid; v_workspace json;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_owner_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'A workspace can only be created for yourself' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_name), '') = '' OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'Workspace name is required (max 120 characters)' USING ERRCODE = '22023';
  END IF;
  INSERT INTO workspaces (name, slug, description, owner_id)
  VALUES (btrim(p_name), p_slug, p_description, v_uid)
  RETURNING id INTO v_workspace_id;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (v_workspace_id, v_uid, 'owner');
  SELECT row_to_json(w.*) INTO v_workspace FROM workspaces w WHERE w.id = v_workspace_id;
  RETURN v_workspace;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(
  p_invitation_id uuid, p_user_id uuid, p_user_email text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_email text := lower(auth.email()); v_invitation record; v_channel_id uuid;
BEGIN
  IF v_uid IS NULL OR p_user_id IS DISTINCT FROM v_uid THEN
    RETURN json_build_object('success', false, 'error', 'You can only accept invitations for your own account.');
  END IF;
  SELECT * INTO v_invitation FROM invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_invitation IS NULL THEN RETURN json_build_object('success', false, 'error', 'Invitation not found.'); END IF;
  IF v_email IS NULL OR lower(v_invitation.email) <> v_email THEN
    RETURN json_build_object('success', false, 'error', 'This invitation was sent to a different email address.');
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RETURN json_build_object('success', false, 'error', 'This invitation is no longer valid.');
  END IF;
  IF v_invitation.expires_at < now() THEN
    UPDATE invitations SET status = 'expired' WHERE id = p_invitation_id;
    RETURN json_build_object('success', false, 'error', 'This invitation has expired.');
  END IF;
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (v_invitation.workspace_id, v_uid, v_invitation.role)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;
  UPDATE invitations SET status = 'accepted', user_id = v_uid WHERE id = p_invitation_id;
  FOR v_channel_id IN
    SELECT unnest(s.default_channel_ids) FROM workspace_settings s WHERE s.workspace_id = v_invitation.workspace_id
  LOOP
    INSERT INTO channel_members (channel_id, user_id)
    SELECT v_channel_id, v_uid
    WHERE EXISTS (SELECT 1 FROM channels c WHERE c.id = v_channel_id AND c.workspace_id = v_invitation.workspace_id)
    ON CONFLICT (channel_id, user_id) DO NOTHING;
  END LOOP;
  RETURN json_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.change_member_role(
  p_workspace_id uuid, p_target_user_id uuid, p_new_role text, p_caller_id uuid
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_caller_role text; v_target_role text;
BEGIN
  IF v_uid IS NULL OR p_caller_id IS DISTINCT FROM v_uid THEN
    RETURN json_build_object('allowed', false, 'reason', 'No permission.');
  END IF;
  IF p_new_role NOT IN ('admin', 'member') THEN
    RETURN json_build_object('allowed', false, 'reason', 'Role must be admin or member. Use ownership transfer for owners.');
  END IF;
  IF p_target_user_id = v_uid THEN
    RETURN json_build_object('allowed', false, 'reason', 'You cannot change your own role.');
  END IF;
  v_caller_role := user_role_in_workspace(p_workspace_id, v_uid);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RETURN json_build_object('allowed', false, 'reason', 'No permission.');
  END IF;
  v_target_role := user_role_in_workspace(p_workspace_id, p_target_user_id);
  IF v_target_role IS NULL THEN RETURN json_build_object('allowed', false, 'reason', 'Not a member.'); END IF;
  IF v_target_role = 'owner' THEN RETURN json_build_object('allowed', false, 'reason', 'Cannot change owner.'); END IF;
  IF v_target_role = 'admin' AND v_caller_role <> 'owner' THEN
    RETURN json_build_object('allowed', false, 'reason', 'Only the owner can change an admin''s role.');
  END IF;
  UPDATE workspace_members SET role = p_new_role, updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, v_uid, 'member_role_changed', 'workspace_member', p_target_user_id,
          jsonb_build_object('from', v_target_role, 'to', p_new_role));
  RETURN json_build_object('allowed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_workspace_member(
  p_workspace_id uuid, p_target_user_id uuid, p_caller_id uuid
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_caller_role text; v_target_role text;
BEGIN
  IF v_uid IS NULL OR p_caller_id IS DISTINCT FROM v_uid THEN
    RETURN json_build_object('allowed', false, 'reason', 'No permission.');
  END IF;
  IF p_target_user_id = v_uid THEN
    RETURN json_build_object('allowed', false, 'reason', 'Use leave instead.');
  END IF;
  v_caller_role := user_role_in_workspace(p_workspace_id, v_uid);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RETURN json_build_object('allowed', false, 'reason', 'Only workspace owners and admins can remove members.');
  END IF;
  v_target_role := user_role_in_workspace(p_workspace_id, p_target_user_id);
  IF v_target_role IS NULL THEN RETURN json_build_object('allowed', false, 'reason', 'Not a member.'); END IF;
  IF v_target_role = 'owner' THEN RETURN json_build_object('allowed', false, 'reason', 'Cannot remove owner.'); END IF;
  IF v_target_role = 'admin' AND v_caller_role <> 'owner' THEN
    RETURN json_build_object('allowed', false, 'reason', 'Only the owner can remove an admin.');
  END IF;
  DELETE FROM workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  RETURN json_build_object('allowed', true);
END;
$$;

-- The client calls (p_workspace_id, p_current_owner_id, p_new_owner_id); the
-- legacy signature used p_caller_id and a non-existent status column, so the
-- feature never worked. Replace it with the signature the client uses.
DROP FUNCTION IF EXISTS public.transfer_workspace_ownership(uuid, uuid, uuid);
CREATE FUNCTION public.transfer_workspace_ownership(
  p_workspace_id uuid, p_current_owner_id uuid, p_new_owner_id uuid
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_current_owner_id IS DISTINCT FROM v_uid THEN
    RETURN json_build_object('error', 'Only the workspace owner can transfer ownership');
  END IF;
  IF user_role_in_workspace(p_workspace_id, v_uid) IS DISTINCT FROM 'owner' THEN
    RETURN json_build_object('error', 'Only the workspace owner can transfer ownership');
  END IF;
  IF p_new_owner_id = v_uid OR user_role_in_workspace(p_workspace_id, p_new_owner_id) IS NULL THEN
    RETURN json_build_object('error', 'New owner must be another workspace member');
  END IF;
  UPDATE workspace_members SET role = 'admin', updated_at = now() WHERE workspace_id = p_workspace_id AND user_id = v_uid;
  UPDATE workspace_members SET role = 'owner', updated_at = now() WHERE workspace_id = p_workspace_id AND user_id = p_new_owner_id;
  UPDATE workspaces SET owner_id = p_new_owner_id WHERE id = p_workspace_id;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, v_uid, 'ownership_transferred', 'workspace', p_workspace_id,
          jsonb_build_object('new_owner_id', p_new_owner_id));
  RETURN json_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_workspace_member_count(p_workspace_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT CASE WHEN user_is_workspace_member(p_workspace_id, auth.uid())
    THEN (SELECT count(*) FROM workspace_members WHERE workspace_id = p_workspace_id)
    ELSE 0 END;
$$;

-- Return only profiles the caller may already see (themselves or co-members).
CREATE OR REPLACE FUNCTION public.get_profiles_by_ids(p_user_ids uuid[])
RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT coalesce(json_agg(row_to_json(p.*)), '[]'::json)
  FROM profiles p
  WHERE p.id = ANY(p_user_ids)
    AND (p.id = auth.uid() OR EXISTS (
      SELECT 1 FROM workspace_members a JOIN workspace_members b ON b.workspace_id = a.workspace_id
      WHERE a.user_id = auth.uid() AND b.user_id = p.id));
$$;

-- Email lookup is limited to people who manage at least one workspace (the invite flow).
CREATE OR REPLACE FUNCTION public.get_user_id_by_email(p_email text)
RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT p.id FROM profiles p
  WHERE lower(p.email) = lower(p_email)
    AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin'))
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read state and conversation RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_channel_read(p_channel_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  UPDATE channel_members SET last_read_at = now()
  WHERE channel_id = p_channel_id AND user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  UPDATE direct_conversation_participants SET last_read_at = now()
  WHERE conversation_id = p_conversation_id AND user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.mark_channel_read_up_to(p_channel_id uuid, p_user_id uuid, p_up_to timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT user_is_channel_member(p_channel_id, v_uid) THEN RETURN; END IF;
  UPDATE channel_members SET last_read_at = GREATEST(coalesce(last_read_at, p_up_to), p_up_to)
  WHERE channel_id = p_channel_id AND user_id = v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_unread_count(p_channel_id uuid, p_user_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT coalesce((
    SELECT count(*)::integer FROM messages m
    WHERE m.channel_id = p_channel_id AND m.parent_id IS NULL AND m.deleted_at IS NULL
      AND m.user_id <> auth.uid()
      AND m.created_at > coalesce(cm.last_read_at, now())
  ), 0)
  FROM channel_members cm
  WHERE cm.channel_id = p_channel_id AND cm.user_id = auth.uid()
    AND user_is_channel_member(p_channel_id, auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.get_unread_counts(p_user_id uuid, p_channel_ids uuid[])
RETURNS TABLE(channel_id uuid, unread_count integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT cm.channel_id,
    (SELECT count(*)::integer FROM messages m
     WHERE m.channel_id = cm.channel_id AND m.parent_id IS NULL AND m.deleted_at IS NULL
       AND m.user_id <> auth.uid() AND m.created_at > coalesce(cm.last_read_at, now()))
  FROM channel_members cm
  JOIN channels c ON c.id = cm.channel_id
  JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id
  WHERE cm.user_id = auth.uid() AND cm.channel_id = ANY(p_channel_ids);
$$;

CREATE OR REPLACE FUNCTION public.mark_message_read(p_message_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_channel uuid;
BEGIN
  SELECT channel_id INTO v_channel FROM messages WHERE id = p_message_id;
  IF v_channel IS NULL OR NOT user_is_channel_member(v_channel, auth.uid()) THEN RETURN; END IF;
  INSERT INTO message_read_receipts (message_id, user_id, read_at)
  VALUES (p_message_id, auth.uid(), now())
  ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_read_receipt_counts(p_message_ids uuid[])
RETURNS TABLE(message_id uuid, read_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT r.message_id, count(*)
  FROM message_read_receipts r JOIN messages m ON m.id = r.message_id
  WHERE r.message_id = ANY(p_message_ids) AND user_is_channel_member(m.channel_id, auth.uid())
  GROUP BY r.message_id;
$$;

CREATE OR REPLACE FUNCTION public.record_message_version(p_message_id uuid, p_user_id uuid, p_content text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM messages WHERE id = p_message_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only the author can record a message version' USING ERRCODE = '42501';
  END IF;
  INSERT INTO message_versions (message_id, user_id, content)
  SELECT id, user_id, content FROM messages WHERE id = p_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_direct_conversation(
  p_workspace_id uuid, p_created_by uuid, p_other_user_id uuid, p_type text DEFAULT 'dm', p_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_channel_id uuid; v_conv_id uuid;
BEGIN
  IF v_uid IS NULL OR p_created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT user_is_workspace_member(p_workspace_id, v_uid) OR NOT user_is_workspace_member(p_workspace_id, p_other_user_id) THEN
    RAISE EXCEPTION 'Both people must be workspace members' USING ERRCODE = '42501';
  END IF;
  IF p_type = 'dm' THEN
    SELECT dc.id INTO v_conv_id FROM direct_conversations dc
    JOIN direct_conversation_participants a ON a.conversation_id = dc.id AND a.user_id = v_uid
    JOIN direct_conversation_participants b ON b.conversation_id = dc.id AND b.user_id = p_other_user_id
    WHERE dc.workspace_id = p_workspace_id AND dc.type = 'dm' LIMIT 1;
    IF v_conv_id IS NOT NULL THEN RETURN v_conv_id; END IF;
  END IF;
  INSERT INTO channels (workspace_id, name, slug, type, is_private, created_by)
  VALUES (p_workspace_id, coalesce(p_name, 'Direct Message'), 'dm-' || encode(gen_random_bytes(8), 'hex'), 'text', true, v_uid)
  RETURNING id INTO v_channel_id;
  INSERT INTO channel_members (channel_id, user_id, role)
  VALUES (v_channel_id, v_uid, 'owner'), (v_channel_id, p_other_user_id, 'member')
  ON CONFLICT DO NOTHING;
  INSERT INTO direct_conversations (workspace_id, channel_id, type, name, created_by)
  VALUES (p_workspace_id, v_channel_id, p_type, p_name, v_uid) RETURNING id INTO v_conv_id;
  INSERT INTO direct_conversation_participants (conversation_id, user_id)
  VALUES (v_conv_id, v_uid), (v_conv_id, p_other_user_id) ON CONFLICT DO NOTHING;
  RETURN v_conv_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_group_conversation(
  p_workspace_id uuid, p_created_by uuid, p_participant_ids uuid[], p_name text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_channel_id uuid; v_conv_id uuid;
BEGIN
  IF v_uid IS NULL OR p_created_by IS DISTINCT FROM v_uid OR NOT user_is_workspace_member(p_workspace_id, v_uid) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_participant_ids) x WHERE NOT user_is_workspace_member(p_workspace_id, x)) THEN
    RAISE EXCEPTION 'All participants must be workspace members' USING ERRCODE = '42501';
  END IF;
  INSERT INTO channels (workspace_id, name, slug, type, is_private, created_by)
  VALUES (p_workspace_id, p_name, 'group-' || encode(gen_random_bytes(8), 'hex'), 'text', true, v_uid)
  RETURNING id INTO v_channel_id;
  INSERT INTO channel_members (channel_id, user_id, role)
  SELECT v_channel_id, x, CASE WHEN x = v_uid THEN 'owner' ELSE 'member' END
  FROM (SELECT v_uid AS x UNION SELECT unnest(p_participant_ids)) s
  ON CONFLICT DO NOTHING;
  INSERT INTO direct_conversations (workspace_id, channel_id, type, name, created_by)
  VALUES (p_workspace_id, v_channel_id, 'group', p_name, v_uid) RETURNING id INTO v_conv_id;
  INSERT INTO direct_conversation_participants (conversation_id, user_id)
  SELECT v_conv_id, x FROM (SELECT v_uid AS x UNION SELECT unnest(p_participant_ids)) s
  ON CONFLICT DO NOTHING;
  RETURN v_conv_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Notifications: the RPC runs with the caller's rights, so the INSERT
--    policy below governs client-created notifications. SECURITY DEFINER
--    callers (owned by postgres) are unaffected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notification_recipient_allowed(p_workspace_id uuid, p_recipient uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT p_recipient = auth.uid()
    OR (
      p_workspace_id IS NOT NULL
      AND user_is_workspace_member(p_workspace_id, auth.uid())
      AND (
        user_is_workspace_member(p_workspace_id, p_recipient)
        OR EXISTS (
          SELECT 1 FROM invitations i
          LEFT JOIN profiles pr ON pr.id = p_recipient
          WHERE i.workspace_id = p_workspace_id AND i.status = 'pending'
            AND (i.user_id = p_recipient OR lower(i.email) = lower(pr.email))
        )
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.create_notification(
  p_user_id uuid, p_type text, p_title text, p_message text, p_link text DEFAULT NULL,
  p_category text DEFAULT 'system', p_entity_type text DEFAULT NULL, p_entity_id uuid DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL, p_workspace_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_notif_id uuid := gen_random_uuid();
BEGIN
  -- No RETURNING: the caller usually cannot SELECT a notification addressed
  -- to someone else, which RETURNING would require under RLS.
  INSERT INTO notifications (id, user_id, type, title, message, link, category, entity_type, entity_id, actor_id, workspace_id)
  VALUES (v_notif_id, p_user_id, p_type, left(p_title, 300), left(p_message, 2000), p_link, p_category, p_entity_type,
          p_entity_id, p_actor_id, p_workspace_id);
  RETURN v_notif_id;
END;
$$;

DROP POLICY IF EXISTS "System can insert notifications" ON notifications;
DROP POLICY IF EXISTS "notifications_insert_scoped" ON notifications;
CREATE POLICY "notifications_insert_scoped" ON notifications FOR INSERT TO authenticated
  WITH CHECK (
    (actor_id IS NULL OR actor_id = auth.uid())
    AND public.notification_recipient_allowed(workspace_id, user_id)
  );

-- user_mentions rows are written by the sender's client for channel members.
DROP POLICY IF EXISTS "System can insert mentions" ON user_mentions;
DROP POLICY IF EXISTS "user_mentions_insert_scoped" ON user_mentions;
CREATE POLICY "user_mentions_insert_scoped" ON user_mentions FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND m.channel_id = user_mentions.channel_id AND m.user_id = auth.uid())
    AND public.user_is_channel_member(channel_id, user_id)
  );

-- ---------------------------------------------------------------------------
-- 6. Messages: authors edit their own messages; workspace owners/admins may
--    only soft-delete. Workspace/channel/author are immutable.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "messages_update" ON messages;
CREATE POLICY "messages_update" ON messages FOR UPDATE TO authenticated
  USING (
    (auth.uid() = user_id AND public.user_is_channel_member(channel_id, auth.uid()))
    OR public.user_is_workspace_admin(public.channel_workspace_id(channel_id), auth.uid())
  )
  WITH CHECK (
    (auth.uid() = user_id AND public.user_is_channel_member(channel_id, auth.uid()))
    OR public.user_is_workspace_admin(public.channel_workspace_id(channel_id), auth.uid())
  );

CREATE OR REPLACE FUNCTION public.messages_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.forwarded_from_message_id IS DISTINCT FROM OLD.forwarded_from_message_id THEN
    RAISE EXCEPTION 'Message routing fields cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.user_id IS DISTINCT FROM auth.uid() THEN
    -- Moderation: only the deletion marker may change.
    IF NEW.content IS DISTINCT FROM OLD.content OR NEW.edited_at IS DISTINCT FROM OLD.edited_at
       OR NEW.link_mode IS DISTINCT FROM OLD.link_mode
       OR NEW.attachments_layout IS DISTINCT FROM OLD.attachments_layout
       OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
      RAISE EXCEPTION 'Only the author can edit a message' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_guard_update ON messages;
CREATE TRIGGER trg_messages_guard_update
  BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION public.messages_guard_update();

-- Message inserts must target a channel in a workspace the author belongs to.
DROP POLICY IF EXISTS "messages_insert" ON messages;
CREATE POLICY "messages_insert" ON messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.user_is_channel_member(channel_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- 7. Always derive workspace/channel scope from the parent row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_message_workspace_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  SELECT ch.workspace_id INTO NEW.workspace_id FROM channels ch WHERE ch.id = NEW.channel_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.set_file_attachment_workspace_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  SELECT ch.workspace_id INTO NEW.workspace_id
  FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE m.id = NEW.message_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.set_reaction_workspace_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  SELECT ch.workspace_id INTO NEW.workspace_id
  FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE m.id = NEW.message_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.set_call_participant_workspace_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  SELECT cs.workspace_id INTO NEW.workspace_id FROM call_sessions cs WHERE cs.id = NEW.call_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.set_read_receipt_channel_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  SELECT m.channel_id INTO NEW.channel_id FROM messages m WHERE m.id = NEW.message_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_file_attachments_workspace_id ON public.file_attachments;
CREATE TRIGGER trg_file_attachments_workspace_id
  BEFORE INSERT OR UPDATE OF message_id ON public.file_attachments
  FOR EACH ROW EXECUTE FUNCTION public.set_file_attachment_workspace_id();

-- ---------------------------------------------------------------------------
-- 8. Channels, channel members and direct conversations.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "channels_select_own_created" ON channels;
CREATE POLICY "channels_select_own_created" ON channels FOR SELECT
  USING (created_by = auth.uid() AND public.user_is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "channels_insert" ON channels;
CREATE POLICY "channels_insert" ON channels FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.user_is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "channel_members_select" ON channel_members;
CREATE POLICY "channel_members_select" ON channel_members FOR SELECT
  USING (
    public.user_is_channel_member(channel_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM channels c
      WHERE c.id = channel_members.channel_id AND c.is_private = false
        AND public.user_is_workspace_member(c.workspace_id, auth.uid())
    )
  );

-- Who may add p_user_id to a channel:
--   * both people must be members of the channel's workspace;
--   * public channel: the person themself, an existing member, or an admin;
--   * private channel: an existing member, or its creator while bootstrapping
--     an empty channel. Workspace admins get no implicit way in.
--   * 1:1 DM: membership is fixed when the conversation is created;
--   * group DM: its creator.
CREATE OR REPLACE FUNCTION public.can_add_channel_member(p_channel_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_ch channels%ROWTYPE; v_dm direct_conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_ch FROM channels WHERE id = p_channel_id;
  IF v_ch.id IS NULL OR v_uid IS NULL THEN RETURN false; END IF;
  IF NOT user_is_workspace_member(v_ch.workspace_id, v_uid) OR NOT user_is_workspace_member(v_ch.workspace_id, p_user_id) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_dm FROM direct_conversations WHERE channel_id = p_channel_id;
  IF v_dm.id IS NOT NULL THEN
    RETURN v_dm.type = 'group' AND v_dm.created_by = v_uid;
  END IF;
  IF NOT coalesce(v_ch.is_private, false) THEN
    RETURN p_user_id = v_uid OR user_is_channel_member(p_channel_id, v_uid)
        OR user_is_workspace_admin(v_ch.workspace_id, v_uid);
  END IF;
  RETURN user_is_channel_member(p_channel_id, v_uid)
      OR (v_ch.created_by = v_uid AND NOT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = p_channel_id));
END;
$$;

DROP POLICY IF EXISTS "channel_members_insert" ON channel_members;
CREATE POLICY "channel_members_insert" ON channel_members FOR INSERT TO authenticated
  WITH CHECK (public.can_add_channel_member(channel_id, user_id));

-- The client upserts its own membership row (last_read_at); keep that narrow.
DROP POLICY IF EXISTS "channel_members_update_own" ON channel_members;
CREATE POLICY "channel_members_update_own" ON channel_members FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.channel_members_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
          OR NEW.role IS DISTINCT FROM OLD.role) THEN
    RAISE EXCEPTION 'Only read state can be updated on a channel membership' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_channel_members_guard_update ON channel_members;
CREATE TRIGGER trg_channel_members_guard_update
  BEFORE UPDATE ON channel_members FOR EACH ROW EXECUTE FUNCTION public.channel_members_guard_update();

DROP POLICY IF EXISTS "direct_conversations_select" ON direct_conversations;
CREATE POLICY "direct_conversations_select" ON direct_conversations FOR SELECT
  USING (public.user_is_dm_participant(id, auth.uid()) OR (created_by = auth.uid() AND public.user_is_workspace_member(workspace_id, auth.uid())));

DROP POLICY IF EXISTS "direct_conversations_insert" ON direct_conversations;
CREATE POLICY "direct_conversations_insert" ON direct_conversations FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.user_is_workspace_member(workspace_id, auth.uid())
    AND EXISTS (SELECT 1 FROM channels c WHERE c.id = channel_id AND c.workspace_id = direct_conversations.workspace_id
                AND c.created_by = auth.uid() AND c.is_private = true)
  );

DROP POLICY IF EXISTS "direct_conv_participants_select" ON direct_conversation_participants;
CREATE POLICY "direct_conv_participants_select" ON direct_conversation_participants FOR SELECT
  USING (
    public.user_is_dm_participant(conversation_id, auth.uid())
    OR EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.id = conversation_id AND dc.created_by = auth.uid())
  );

DROP POLICY IF EXISTS "direct_conv_participants_insert" ON direct_conversation_participants;
CREATE POLICY "direct_conv_participants_insert" ON direct_conversation_participants FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM direct_conversations dc
      WHERE dc.id = conversation_id AND dc.created_by = auth.uid()
        AND public.user_is_workspace_member(dc.workspace_id, direct_conversation_participants.user_id)
    )
  );

DROP POLICY IF EXISTS "direct_conv_participants_update_own" ON direct_conversation_participants;
CREATE POLICY "direct_conv_participants_update_own" ON direct_conversation_participants FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 9. File attachments: a row may only point at an object the inserter can
--    already read, so references cannot be used to gain access to a file.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_file_attachments_file_url ON file_attachments(file_url);
CREATE INDEX IF NOT EXISTS idx_sched_msg_attach_file_url ON scheduled_message_attachments(file_url);

CREATE OR REPLACE FUNCTION public.normalize_attachment_path(p_url text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_url IS NULL OR p_url ~* '^(https?|data|blob):' THEN NULL
    WHEN p_url LIKE 'message-attachments/%' THEN substr(p_url, length('message-attachments/') + 1)
    ELSE p_url
  END;
$$;

-- Does the caller own (uploaded) this object? Never referenced from a
-- storage.objects policy, so it cannot recurse through storage RLS.
CREATE OR REPLACE FUNCTION public.storage_object_owned_by_caller(p_bucket text, p_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = p_bucket AND o.name = p_name
      AND (o.owner = auth.uid() OR o.owner_id = auth.uid()::text)
  );
$$;

-- Can the current user read this message-attachments object through a row
-- that references it? (Ownership is checked separately in the policy.)
-- Extended by the Drive migration (drive versions referencing the object).
-- Must not query storage.objects: it is called from storage.objects policies.
CREATE OR REPLACE FUNCTION public.storage_attachment_readable(p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_name IS NULL THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM file_attachments fa JOIN messages m ON m.id = fa.message_id
    WHERE fa.file_url IN (p_name, 'message-attachments/' || p_name)
      AND user_is_channel_member(m.channel_id, v_uid)
  ) THEN RETURN true; END IF;
  IF EXISTS (
    SELECT 1 FROM scheduled_message_attachments sa JOIN scheduled_messages s ON s.id = sa.scheduled_message_id
    WHERE sa.file_url IN (p_name, 'message-attachments/' || p_name) AND s.user_id = v_uid
  ) THEN RETURN true; END IF;
  IF p_name LIKE 'project-resources/%' AND EXISTS (
    SELECT 1 FROM project_resources pr JOIN projects p ON p.id = pr.project_id
    WHERE pr.type = 'image' AND pr.url IN (p_name, 'message-attachments/' || p_name)
      AND (user_is_workspace_member(p.workspace_id, v_uid))
  ) THEN RETURN true; END IF;
  IF p_name LIKE 'automation/%' AND EXISTS (
    SELECT 1 FROM automation_actions aa
    WHERE jsonb_typeof(aa.config -> 'attachments') = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(aa.config -> 'attachments') att
                  WHERE att ->> 'file_url' IN (p_name, 'message-attachments/' || p_name))
      AND can_view_automation_rule(aa.rule_id)
  ) THEN RETURN true; END IF;
  RETURN false;
END;
$$;

-- Objects may only be deleted by their uploader once nothing references them.
CREATE OR REPLACE FUNCTION public.storage_attachment_unreferenced(p_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM file_attachments WHERE file_url IN (p_name, 'message-attachments/' || p_name))
     AND NOT EXISTS (SELECT 1 FROM scheduled_message_attachments WHERE file_url IN (p_name, 'message-attachments/' || p_name))
     AND NOT EXISTS (SELECT 1 FROM project_resources WHERE url IN (p_name, 'message-attachments/' || p_name))
     AND NOT EXISTS (
       SELECT 1 FROM automation_actions aa
       WHERE jsonb_typeof(aa.config -> 'attachments') = 'array'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(aa.config -> 'attachments') att
                     WHERE att ->> 'file_url' IN (p_name, 'message-attachments/' || p_name)));
$$;

DROP POLICY IF EXISTS "file_attachments_insert" ON file_attachments;
CREATE POLICY "file_attachments_insert" ON file_attachments FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = message_id AND m.user_id = auth.uid() AND public.user_is_channel_member(m.channel_id, auth.uid())
    )
    AND (
      file_type = 'application/x-link'
      OR public.normalize_attachment_path(file_url) IS NULL
      OR public.storage_object_owned_by_caller('message-attachments', public.normalize_attachment_path(file_url))
      OR public.storage_attachment_readable(public.normalize_attachment_path(file_url))
    )
  );

CREATE OR REPLACE FUNCTION public.file_attachments_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.file_url IS DISTINCT FROM OLD.file_url OR NEW.message_id IS DISTINCT FROM OLD.message_id
          OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'Attachment references cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_file_attachments_guard_update ON file_attachments;
CREATE TRIGGER trg_file_attachments_guard_update
  BEFORE UPDATE ON file_attachments FOR EACH ROW EXECUTE FUNCTION public.file_attachments_guard_update();

DROP POLICY IF EXISTS "scheduled_msg_attach_insert_own" ON scheduled_message_attachments;
CREATE POLICY "scheduled_msg_attach_insert_own" ON scheduled_message_attachments FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND scheduled_message_id IN (SELECT id FROM scheduled_messages WHERE user_id = auth.uid())
    AND (
      file_type = 'application/x-link'
      OR public.normalize_attachment_path(file_url) IS NULL
      OR public.storage_object_owned_by_caller('message-attachments', public.normalize_attachment_path(file_url))
      OR public.storage_attachment_readable(public.normalize_attachment_path(file_url))
    )
  );

DROP POLICY IF EXISTS "project_resources_insert" ON project_resources;
CREATE POLICY "project_resources_insert" ON project_resources FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = created_by
    AND public.is_workspace_member((SELECT workspace_id FROM projects WHERE id = project_resources.project_id))
    AND (
      type = 'link'
      OR public.storage_object_owned_by_caller('message-attachments', public.normalize_attachment_path(url))
      OR public.storage_attachment_readable(public.normalize_attachment_path(url))
    )
  );

-- ---------------------------------------------------------------------------
-- 10. Storage policies for message-attachments.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "attachments_upload" ON storage.objects;
DROP POLICY IF EXISTS "attachments_read" ON storage.objects;
DROP POLICY IF EXISTS "attachments_delete" ON storage.objects;
DROP POLICY IF EXISTS "attachments_update" ON storage.objects;

-- Uploads cannot overwrite another user's object (the update policy below is
-- owner-only), so an authenticated upload is safe; access is decided at read
-- time by ownership or by a visible referencing row.
CREATE POLICY "attachments_upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'message-attachments' AND auth.uid() IS NOT NULL);

CREATE POLICY "attachments_read" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'message-attachments'
    AND (owner = auth.uid() OR owner_id = auth.uid()::text OR public.storage_attachment_readable(name))
  );

CREATE POLICY "attachments_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'message-attachments' AND (owner = auth.uid() OR owner_id = auth.uid()::text))
  WITH CHECK (bucket_id = 'message-attachments' AND (owner = auth.uid() OR owner_id = auth.uid()::text));

CREATE POLICY "attachments_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'message-attachments'
    AND (owner = auth.uid() OR owner_id = auth.uid()::text)
    AND public.storage_attachment_unreferenced(name)
  );

-- ---------------------------------------------------------------------------
-- 11. Workspace membership and workspace rows: role and ownership changes go
--     through the RPCs above; direct client writes cannot escalate.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "wm_insert" ON workspace_members;
CREATE POLICY "wm_insert" ON workspace_members FOR INSERT TO authenticated
  WITH CHECK (
    public.user_is_workspace_admin(workspace_id, auth.uid())
    OR (
      user_id = auth.uid()
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid())
      AND NOT EXISTS (SELECT 1 FROM workspace_members existing WHERE existing.workspace_id = workspace_members.workspace_id)
    )
  );

CREATE OR REPLACE FUNCTION public.workspace_members_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner' AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'Owners are assigned by ownership transfer' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'Use change_member_role to change roles' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  ELSE
    IF OLD.role = 'owner' THEN
      RAISE EXCEPTION 'Transfer ownership before removing the owner' USING ERRCODE = '42501';
    END IF;
    IF OLD.user_id <> auth.uid() AND OLD.role = 'admin'
       AND user_role_in_workspace(OLD.workspace_id, auth.uid()) IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'Only the owner can remove an admin' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_members_guard ON workspace_members;
CREATE TRIGGER trg_workspace_members_guard
  BEFORE INSERT OR UPDATE OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.workspace_members_guard();

CREATE OR REPLACE FUNCTION public.workspaces_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Use transfer_workspace_ownership to change the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_workspaces_guard_update ON workspaces;
CREATE TRIGGER trg_workspaces_guard_update
  BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION public.workspaces_guard_update();

-- Removing a member removes everything that membership granted in that workspace.
CREATE OR REPLACE FUNCTION public.on_workspace_member_removed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  DELETE FROM channel_members cm USING channels c
  WHERE cm.channel_id = c.id AND c.workspace_id = OLD.workspace_id AND cm.user_id = OLD.user_id;
  DELETE FROM direct_conversation_participants p USING direct_conversations dc
  WHERE p.conversation_id = dc.id AND dc.workspace_id = OLD.workspace_id AND p.user_id = OLD.user_id;
  DELETE FROM project_members pm USING projects p
  WHERE pm.project_id = p.id AND p.workspace_id = OLD.workspace_id AND pm.user_id = OLD.user_id;
  DELETE FROM task_assignees ta USING tasks t
  WHERE ta.task_id = t.id AND t.workspace_id = OLD.workspace_id AND ta.user_id = OLD.user_id;
  DELETE FROM user_mentions um USING channels c
  WHERE um.channel_id = c.id AND c.workspace_id = OLD.workspace_id AND um.user_id = OLD.user_id;
  DELETE FROM user_favorites uf USING channels c
  WHERE uf.entity_type = 'channel' AND uf.entity_id = c.id AND c.workspace_id = OLD.workspace_id AND uf.user_id = OLD.user_id;
  DELETE FROM user_drafts d USING channels c
  WHERE d.channel_id = c.id AND c.workspace_id = OLD.workspace_id AND d.user_id = OLD.user_id;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_member_removed ON workspace_members;
CREATE TRIGGER trg_workspace_member_removed
  AFTER DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION public.on_workspace_member_removed();

-- The legacy audit trigger wrote audit rows for a workspace that was being
-- deleted (cascade), violating audit_log's foreign key, so deleting any
-- workspace with members or channels failed. Skip auditing in that case.
CREATE OR REPLACE FUNCTION public.fn_audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_workspace_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'workspace_members' THEN
    v_workspace_id := coalesce(NEW.workspace_id, OLD.workspace_id);
  ELSIF TG_TABLE_NAME = 'channels' THEN
    v_workspace_id := coalesce(NEW.workspace_id, OLD.workspace_id);
  ELSIF TG_TABLE_NAME = 'messages' AND TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    SELECT workspace_id INTO v_workspace_id FROM channels WHERE id = OLD.channel_id;
  ELSE
    RETURN coalesce(NEW, OLD);
  END IF;
  IF v_workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = v_workspace_id) THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'workspace_members' THEN
    INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (v_workspace_id, auth.uid(), CASE WHEN TG_OP = 'INSERT' THEN 'member_joined' ELSE 'member_left' END,
            'workspace_member', coalesce(NEW.user_id, OLD.user_id),
            jsonb_build_object('user_id', coalesce(NEW.user_id, OLD.user_id)));
  ELSIF TG_TABLE_NAME = 'channels' THEN
    INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (v_workspace_id, auth.uid(), 'channel_' || lower(TG_OP), 'channel', coalesce(NEW.id, OLD.id),
            jsonb_build_object('name', coalesce(NEW.name, OLD.name), 'is_private', coalesce(NEW.is_private, OLD.is_private)));
  ELSE
    INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (v_workspace_id, auth.uid(), 'message_deleted', 'message', OLD.id, jsonb_build_object('channel_id', OLD.channel_id));
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

-- Clean stale memberships left behind by removals before this migration.
DELETE FROM channel_members cm
USING channels c
WHERE cm.channel_id = c.id
  AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id);

-- ---------------------------------------------------------------------------
-- 12. Tasks and projects RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_edit_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = p_task_id AND user_is_workspace_member(t.workspace_id, auth.uid())
      AND (t.created_by = auth.uid() OR is_task_assignee(t.id, auth.uid())
           OR (t.project_id IS NOT NULL AND is_project_editor(t.project_id, auth.uid()))
           OR is_workspace_admin(t.workspace_id, auth.uid()))
  );
$$;

CREATE OR REPLACE FUNCTION public.can_delete_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = p_task_id AND user_is_workspace_member(t.workspace_id, auth.uid())
      AND (t.created_by = auth.uid() OR is_workspace_admin(t.workspace_id, auth.uid())
           OR (t.project_id IS NOT NULL AND is_project_admin(t.project_id, auth.uid())))
  );
$$;

CREATE OR REPLACE FUNCTION public.create_task(
  p_workspace_id uuid, p_title text, p_description text DEFAULT NULL, p_status text DEFAULT 'todo',
  p_priority text DEFAULT 'medium', p_due_date timestamptz DEFAULT NULL, p_project_id uuid DEFAULT NULL,
  p_channel_id uuid DEFAULT NULL, p_message_id uuid DEFAULT NULL, p_assignee_ids uuid[] DEFAULT '{}',
  p_label_ids uuid[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid(); v_task_id uuid; v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT user_is_workspace_member(p_workspace_id, v_uid) THEN
    RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NOT NULL AND (get_project_workspace_id(p_project_id) IS DISTINCT FROM p_workspace_id
     OR NOT is_project_editor(p_project_id, v_uid)) THEN
    RAISE EXCEPTION 'No permission to add tasks to this project' USING ERRCODE = '42501';
  END IF;
  IF p_channel_id IS NOT NULL AND NOT user_is_channel_member(p_channel_id, v_uid) THEN
    RAISE EXCEPTION 'No access to the source channel' USING ERRCODE = '42501';
  END IF;
  INSERT INTO tasks (workspace_id, title, description, status, priority, due_date, project_id, channel_id, message_id, created_by)
  VALUES (p_workspace_id, p_title, p_description, p_status, p_priority, p_due_date, p_project_id, p_channel_id, p_message_id, v_uid)
  RETURNING id INTO v_task_id;
  FOREACH v_id IN ARRAY coalesce(p_assignee_ids, '{}') LOOP
    IF user_is_workspace_member(p_workspace_id, v_id) THEN
      INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES (v_task_id, v_id, v_uid) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  FOREACH v_id IN ARRAY coalesce(p_label_ids, '{}') LOOP
    INSERT INTO task_label_assignments (task_id, label_id)
    SELECT v_task_id, l.id FROM task_labels l WHERE l.id = v_id AND l.workspace_id = p_workspace_id
    ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (v_task_id, v_uid, 'created', jsonb_build_object('title', p_title));
  RETURN v_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_task_status(p_task_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT can_edit_task(p_task_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  UPDATE tasks SET status = p_status, updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (p_task_id, auth.uid(), 'status_changed', jsonb_build_object('status', p_status));
END $$;

CREATE OR REPLACE FUNCTION public.update_task(
  p_task_id uuid, p_title text DEFAULT NULL, p_description text DEFAULT NULL, p_status text DEFAULT NULL,
  p_priority text DEFAULT NULL, p_due_date timestamptz DEFAULT NULL, p_start_date timestamptz DEFAULT NULL,
  p_project_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_workspace uuid;
BEGIN
  IF NOT can_edit_task(p_task_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  SELECT workspace_id INTO v_workspace FROM tasks WHERE id = p_task_id;
  IF p_project_id IS NOT NULL AND get_project_workspace_id(p_project_id) IS DISTINCT FROM v_workspace THEN
    RAISE EXCEPTION 'Project belongs to another workspace' USING ERRCODE = '42501';
  END IF;
  UPDATE tasks SET title = coalesce(p_title, title), description = coalesce(p_description, description),
    status = coalesce(p_status, status), priority = coalesce(p_priority, priority),
    due_date = coalesce(p_due_date, due_date), start_date = coalesce(p_start_date, start_date),
    project_id = coalesce(p_project_id, project_id), updated_at = now()
  WHERE id = p_task_id;
END $$;

CREATE OR REPLACE FUNCTION public.delete_task(p_task_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT can_delete_task(p_task_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  DELETE FROM tasks WHERE id = p_task_id;
END $$;

CREATE OR REPLACE FUNCTION public.archive_task(p_task_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT can_edit_task(p_task_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  UPDATE tasks SET archived_at = now(), updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (p_task_id, auth.uid(), 'archived', '{}');
END $$;

CREATE OR REPLACE FUNCTION public.restore_task(p_task_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT can_edit_task(p_task_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  UPDATE tasks SET archived_at = NULL, updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (p_task_id, auth.uid(), 'restored', '{}');
END $$;

CREATE OR REPLACE FUNCTION public.move_task_to_column(p_task_id uuid, p_column_id uuid, p_sort_order integer DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT can_edit_task(p_task_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  IF p_column_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM project_columns pc JOIN tasks t ON t.project_id = pc.project_id
    WHERE pc.id = p_column_id AND t.id = p_task_id) THEN
    RAISE EXCEPTION 'Column belongs to another project' USING ERRCODE = '42501';
  END IF;
  UPDATE tasks SET column_id = p_column_id, sort_order = p_sort_order, updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details)
  VALUES (p_task_id, auth.uid(), 'moved', jsonb_build_object('column_id', p_column_id, 'sort_order', p_sort_order));
END $$;

CREATE OR REPLACE FUNCTION public.message_to_task(p_message_id uuid, p_title text DEFAULT NULL, p_workspace_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_msg record; v_task_id uuid;
BEGIN
  SELECT m.id, m.content, c.workspace_id, c.id AS channel_id INTO v_msg
  FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = p_message_id;
  IF v_msg.id IS NULL OR NOT user_is_channel_member(v_msg.channel_id, auth.uid()) THEN
    RAISE EXCEPTION 'Message not found' USING ERRCODE = '42501';
  END IF;
  INSERT INTO tasks (workspace_id, channel_id, message_id, title, description, created_by)
  VALUES (v_msg.workspace_id, v_msg.channel_id, p_message_id, coalesce(p_title, left(v_msg.content, 100)), v_msg.content, auth.uid())
  RETURNING id INTO v_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details)
  VALUES (v_task_id, auth.uid(), 'created', jsonb_build_object('source', 'message', 'message_id', p_message_id));
  RETURN v_task_id;
END $$;

-- Runs with the caller's rights: tasks RLS decides visibility.
CREATE OR REPLACE FUNCTION public.get_workspace_tasks(
  p_workspace_id uuid, p_status text DEFAULT NULL, p_project_id uuid DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS TABLE(task_id uuid, title text, description text, status text, priority text, due_date timestamptz, project_id uuid,
  channel_id uuid, created_by uuid, creator_name text, creator_avatar text, assignee_names text[], assignee_avatars text[],
  label_names text[], label_colors text[], comment_count bigint, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $$
BEGIN RETURN QUERY
  SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.project_id, t.channel_id, t.created_by,
    cp.display_name, cp.avatar_url,
    coalesce(ARRAY(SELECT DISTINCT pr2.display_name FROM task_assignees ta2 JOIN profiles pr2 ON pr2.id = ta2.user_id WHERE ta2.task_id = t.id), '{}'),
    coalesce(ARRAY(SELECT DISTINCT pr3.avatar_url FROM task_assignees ta3 JOIN profiles pr3 ON pr3.id = ta3.user_id WHERE ta3.task_id = t.id), '{}'),
    coalesce(ARRAY(SELECT DISTINCT tl.name FROM task_label_assignments tla JOIN task_labels tl ON tl.id = tla.label_id WHERE tla.task_id = t.id), '{}'),
    coalesce(ARRAY(SELECT DISTINCT tl2.color FROM task_label_assignments tla2 JOIN task_labels tl2 ON tl2.id = tla2.label_id WHERE tla2.task_id = t.id), '{}'),
    (SELECT count(*) FROM task_comments tc WHERE tc.task_id = t.id AND tc.deleted_at IS NULL),
    t.created_at, t.updated_at
  FROM tasks t LEFT JOIN profiles cp ON cp.id = t.created_by
  WHERE t.workspace_id = p_workspace_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
    AND (p_status IS NULL OR t.status = p_status) AND (p_project_id IS NULL OR t.project_id = p_project_id)
  ORDER BY t.created_at DESC LIMIT least(p_limit, 200) OFFSET p_offset;
END $$;

DROP POLICY IF EXISTS "task_assignees_insert" ON task_assignees;
CREATE POLICY "task_assignees_insert" ON task_assignees FOR INSERT TO authenticated
  WITH CHECK (
    (public.is_task_creator(task_id) OR public.is_workspace_admin((SELECT workspace_id FROM tasks WHERE id = task_id)))
    AND public.user_is_workspace_member((SELECT workspace_id FROM tasks WHERE id = task_id), user_id)
  );

DROP POLICY IF EXISTS "task_activity_insert" ON task_activity;
CREATE POLICY "task_activity_insert" ON task_activity FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_workspace_member_for_task(task_id));

DROP POLICY IF EXISTS "automation_logs_insert" ON automation_execution_logs;
CREATE POLICY "automation_logs_insert" ON automation_execution_logs FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_automation_rule(rule_id));

-- Projects: the legacy RPC referenced a non-existent created_by column.
CREATE OR REPLACE FUNCTION public.create_project(
  p_workspace_id uuid, p_name text, p_description text DEFAULT NULL, p_icon text DEFAULT '📋',
  p_color text DEFAULT '#6366f1', p_due_date timestamptz DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_project_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_member(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '42501';
  END IF;
  INSERT INTO projects (workspace_id, name, description, icon, color, owner_id, due_date)
  VALUES (p_workspace_id, p_name, p_description, p_icon, p_color, auth.uid(), p_due_date)
  RETURNING id INTO v_project_id;
  INSERT INTO project_members (project_id, user_id, role) VALUES (v_project_id, auth.uid(), 'owner');
  INSERT INTO project_columns (project_id, name, sort_order, position)
  VALUES (v_project_id, 'Backlog', 0, 0), (v_project_id, 'To Do', 1, 1), (v_project_id, 'In Progress', 2, 2), (v_project_id, 'Done', 3, 3);
  RETURN v_project_id;
END $$;

CREATE OR REPLACE FUNCTION public.can_manage_project_members(p_project_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT user_is_workspace_member(get_project_workspace_id(p_project_id), auth.uid())
     AND (is_project_owner(p_project_id, auth.uid()) OR is_project_admin(p_project_id, auth.uid())
          OR is_workspace_admin(get_project_workspace_id(p_project_id), auth.uid()));
$$;

CREATE OR REPLACE FUNCTION public.add_project_member(p_project_id uuid, p_user_id uuid, p_role text DEFAULT 'member')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT can_manage_project_members(p_project_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  IF p_role NOT IN ('admin', 'member', 'viewer') THEN RAISE EXCEPTION 'Invalid role' USING ERRCODE = '22023'; END IF;
  IF NOT user_is_workspace_member(get_project_workspace_id(p_project_id), p_user_id) THEN
    RAISE EXCEPTION 'User is not a workspace member' USING ERRCODE = '42501';
  END IF;
  INSERT INTO project_members (project_id, user_id, role) VALUES (p_project_id, p_user_id, p_role)
  ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role;
END $$;

CREATE OR REPLACE FUNCTION public.remove_project_member(p_member_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row project_members%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM project_members WHERE id = p_member_id;
  IF v_row.id IS NULL THEN RETURN; END IF;
  IF v_row.user_id <> auth.uid() AND NOT can_manage_project_members(v_row.project_id) THEN
    RAISE EXCEPTION 'No permission' USING ERRCODE = '42501';
  END IF;
  IF v_row.role = 'owner' THEN RAISE EXCEPTION 'The project owner cannot be removed' USING ERRCODE = '42501'; END IF;
  DELETE FROM project_members WHERE id = p_member_id;
END $$;

CREATE OR REPLACE FUNCTION public.update_project_member_role(p_member_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_row project_members%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM project_members WHERE id = p_member_id;
  IF v_row.id IS NULL OR NOT can_manage_project_members(v_row.project_id) THEN
    RAISE EXCEPTION 'No permission' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('admin', 'member', 'viewer') OR v_row.role = 'owner' THEN
    RAISE EXCEPTION 'Invalid role change' USING ERRCODE = '22023';
  END IF;
  UPDATE project_members SET role = p_role WHERE id = p_member_id;
END $$;

CREATE OR REPLACE FUNCTION public.get_project_member_count(p_project_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_visibility text; v_workspace_id uuid;
BEGIN
  IF NOT is_project_readable(p_project_id, auth.uid()) THEN RETURN 0; END IF;
  SELECT visibility, workspace_id INTO v_visibility, v_workspace_id FROM projects WHERE id = p_project_id;
  IF v_visibility = 'workspace' THEN
    RETURN (SELECT count(*) FROM workspace_members WHERE workspace_id = v_workspace_id);
  END IF;
  RETURN (SELECT count(*) FROM project_members WHERE project_id = p_project_id);
END $$;

CREATE OR REPLACE FUNCTION public.get_project_members(p_project_id uuid)
RETURNS TABLE(id uuid, user_id uuid, role text, created_at timestamptz, display_name text, avatar_url text, email text, is_implicit boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT is_project_readable(p_project_id, auth.uid()) THEN RETURN; END IF;
  RETURN QUERY
  SELECT pm.id, pm.user_id, pm.role, pm.created_at, p.display_name, p.avatar_url, p.email, false
  FROM project_members pm LEFT JOIN profiles p ON p.id = pm.user_id
  WHERE pm.project_id = p_project_id
  UNION ALL
  SELECT wm.id, wm.user_id, 'viewer'::text, wm.created_at, p.display_name, p.avatar_url, p.email, true
  FROM workspace_members wm
  JOIN projects pr ON pr.id = p_project_id AND pr.visibility = 'workspace' AND wm.workspace_id = pr.workspace_id AND wm.user_id <> pr.owner_id
  LEFT JOIN profiles p ON p.id = wm.user_id
  WHERE NOT EXISTS (SELECT 1 FROM project_members pm2 WHERE pm2.project_id = pr.id AND pm2.user_id = wm.user_id)
  ORDER BY 8, 4;
END $$;

CREATE OR REPLACE FUNCTION public.get_project_member_ids(p_project_id uuid)
RETURNS TABLE(user_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT pm.user_id, pm.role FROM project_members pm
  WHERE pm.project_id = p_project_id AND is_project_readable(p_project_id, auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 13. Calendar, automation and call RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_events_participants(p_event_ids uuid[])
RETURNS TABLE(event_id uuid, user_id uuid, display_name text, avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT ep.event_id, ep.user_id, coalesce(p.display_name, p.email, 'Unknown'), p.avatar_url
  FROM event_participants ep
  JOIN calendar_events ce ON ce.id = ep.event_id
  LEFT JOIN profiles p ON p.id = ep.user_id
  WHERE ep.event_id = ANY(p_event_ids) AND user_is_workspace_member(ce.workspace_id, auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.add_event_participant(p_event_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_event calendar_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM calendar_events WHERE id = p_event_id;
  IF v_event.id IS NULL OR v_event.user_id <> auth.uid() THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  IF NOT user_is_workspace_member(v_event.workspace_id, p_user_id) THEN
    RAISE EXCEPTION 'Participant must be a workspace member' USING ERRCODE = '42501';
  END IF;
  INSERT INTO event_participants (event_id, user_id) VALUES (p_event_id, p_user_id) ON CONFLICT (event_id, user_id) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public.remove_event_participant_by_id(p_participant_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  DELETE FROM event_participants ep USING calendar_events ce
  WHERE ep.id = p_participant_id AND ce.id = ep.event_id AND (ce.user_id = auth.uid() OR ep.user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.update_automation_rule(
  p_rule_id uuid, p_name text DEFAULT NULL, p_description text DEFAULT NULL, p_enabled boolean DEFAULT NULL,
  p_triggers jsonb DEFAULT NULL, p_conditions jsonb DEFAULT NULL, p_actions jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_trigger jsonb; v_condition jsonb; v_action jsonb;
BEGIN
  IF NOT can_manage_automation_rule(p_rule_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  UPDATE automation_rules SET name = coalesce(p_name, name), description = coalesce(p_description, description),
    enabled = coalesce(p_enabled, enabled), updated_at = now() WHERE id = p_rule_id;
  IF p_triggers IS NOT NULL THEN
    DELETE FROM automation_triggers WHERE rule_id = p_rule_id;
    FOR v_trigger IN SELECT * FROM jsonb_array_elements(p_triggers) LOOP
      INSERT INTO automation_triggers (rule_id, event_type) VALUES (p_rule_id, coalesce(v_trigger->>'event_type', ''));
    END LOOP;
  END IF;
  IF p_conditions IS NOT NULL THEN
    DELETE FROM automation_conditions WHERE rule_id = p_rule_id;
    FOR v_condition IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
      INSERT INTO automation_conditions (rule_id, field, operator, value, logic)
      VALUES (p_rule_id, coalesce(v_condition->>'field', ''), coalesce(v_condition->>'operator', 'equals'),
              coalesce(v_condition->>'value', ''), coalesce(v_condition->>'logic', 'and'));
    END LOOP;
  END IF;
  IF p_actions IS NOT NULL THEN
    DELETE FROM automation_actions WHERE rule_id = p_rule_id;
    FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions) LOOP
      INSERT INTO automation_actions (rule_id, action_type, config, sort_order)
      VALUES (p_rule_id, coalesce(v_action->>'action_type', 'post_message'), coalesce(v_action->'config', '{}'::jsonb),
              coalesce((v_action->>'sort_order')::integer, 0));
    END LOOP;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.toggle_automation_rule(p_rule_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_new_state boolean;
BEGIN
  IF NOT can_manage_automation_rule(p_rule_id) THEN RAISE EXCEPTION 'No permission' USING ERRCODE = '42501'; END IF;
  UPDATE automation_rules SET enabled = NOT enabled, updated_at = now() WHERE id = p_rule_id RETURNING enabled INTO v_new_state;
  RETURN v_new_state;
END $$;

CREATE OR REPLACE FUNCTION public.cleanup_call_signaling(p_call_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF p_call_id IS NULL THEN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN RETURN; END IF;
    DELETE FROM call_signaling WHERE created_at < now() - interval '1 hour';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM call_sessions cs WHERE cs.id = p_call_id AND cs.created_by = auth.uid())
     OR EXISTS (SELECT 1 FROM call_participants cp WHERE cp.call_id = p_call_id AND cp.user_id = auth.uid()) THEN
    DELETE FROM call_signaling WHERE call_id = p_call_id;
  END IF;
END $$;

-- Membership-scoped search; private channels only for their members.
CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_workspace_id uuid, p_limit integer DEFAULT 20)
RETURNS TABLE(result_type text, id uuid, title text, subtitle text, avatar_url text, link text, created_at timestamptz, rank real)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT user_is_workspace_member(p_workspace_id, auth.uid()) THEN RETURN; END IF;
  RETURN QUERY
  SELECT * FROM (
    SELECT 'message'::text, m.id, m.content, c.name, pr.avatar_url, '/channels/' || c.slug || '#message-' || m.id, m.created_at,
      ts_rank(to_tsvector('english', coalesce(m.content, '')), plainto_tsquery('english', p_query))
    FROM messages m JOIN channels c ON c.id = m.channel_id JOIN profiles pr ON pr.id = m.user_id
    WHERE c.workspace_id = p_workspace_id AND m.deleted_at IS NULL AND user_is_channel_member(c.id, auth.uid())
      AND to_tsvector('english', coalesce(m.content, '')) @@ plainto_tsquery('english', p_query)
    UNION ALL
    SELECT 'channel'::text, c.id, c.name, coalesce(c.description, ''), NULL::text, '/channels/' || c.slug, c.created_at,
      ts_rank(to_tsvector('english', c.name || ' ' || coalesce(c.description, '')), plainto_tsquery('english', p_query))
    FROM channels c
    WHERE c.workspace_id = p_workspace_id AND c.archived_at IS NULL
      AND (c.is_private = false OR user_is_channel_member(c.id, auth.uid()))
      AND NOT EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.channel_id = c.id)
      AND to_tsvector('english', c.name || ' ' || coalesce(c.description, '')) @@ plainto_tsquery('english', p_query)
    UNION ALL
    SELECT 'user'::text, pr.id, coalesce(pr.display_name, pr.username), pr.username, pr.avatar_url, NULL::text, pr.created_at,
      ts_rank(to_tsvector('english', coalesce(pr.display_name, '') || ' ' || coalesce(pr.username, '')), plainto_tsquery('english', p_query))
    FROM profiles pr JOIN workspace_members wm ON wm.user_id = pr.id
    WHERE wm.workspace_id = p_workspace_id
      AND to_tsvector('english', coalesce(pr.display_name, '') || ' ' || coalesce(pr.username, '')) @@ plainto_tsquery('english', p_query)
  ) results ORDER BY 8 DESC LIMIT least(p_limit, 100);
END $$;

-- The five-argument overload is ambiguous with the nine-argument one (all
-- extra parameters have defaults); the client always calls the full form.
DROP FUNCTION IF EXISTS public.upsert_workspace_settings(uuid, uuid[], integer, text, text);

-- ---------------------------------------------------------------------------
-- 14. No client RPC is callable anonymously except the public invite page.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_anon_rpc_access()
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND pg_get_function_result(p.oid) <> 'trigger'
      AND p.proname NOT IN (
        -- Public invite landing page
        'get_workspace_invite_link_info',
        -- Pure predicates referenced by RLS policies that also apply to anon
        'user_is_workspace_member', 'user_is_workspace_admin', 'user_is_channel_member', 'is_workspace_member',
        'is_workspace_admin', 'is_workspace_member_for_task', 'is_task_assignee', 'is_task_creator', 'is_project_owner',
        'is_project_admin', 'is_project_member', 'is_project_editor', 'is_project_viewer', 'is_project_readable',
        'get_project_workspace_id', 'can_view_automation_rule', 'can_manage_automation_rule', 'is_automation_owner_admin',
        'channel_workspace_id', 'user_is_dm_participant', 'normalize_attachment_path'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.revoke_anon_rpc_access() FROM PUBLIC, anon, authenticated;

SELECT public.revoke_anon_rpc_access();

NOTIFY pgrst, 'reload schema';
