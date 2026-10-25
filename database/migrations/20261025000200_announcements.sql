-- ============================================================================
-- 20261025000200_announcements.sql
-- ----------------------------------------------------------------------------
-- @all (or @everyone) in the General channel notifies every member, with a
-- push notification. The author asks for it right after posting; it runs once
-- per message.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.message_announcements (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  notified integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE message_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON message_announcements FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_channel_everyone(p_message_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_msg messages%ROWTYPE; v_channel channels%ROWTYPE; v_sender text; v_count integer;
BEGIN
  SELECT * INTO v_msg FROM messages WHERE id = p_message_id;
  IF v_msg.id IS NULL OR v_msg.user_id IS DISTINCT FROM auth.uid() OR v_msg.agent_id IS NOT NULL
     OR v_msg.deleted_at IS NOT NULL OR v_msg.created_at < now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'Message not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_channel FROM channels WHERE id = v_msg.channel_id;
  IF v_channel.slug IS DISTINCT FROM 'general' THEN
    RAISE EXCEPTION '@all only works in the General channel' USING ERRCODE = '22023';
  END IF;
  IF NOT user_is_channel_member(v_channel.id, auth.uid()) THEN
    RAISE EXCEPTION 'Message not found' USING ERRCODE = '42501';
  END IF;
  IF coalesce(v_msg.content, '') !~* '(^|[^A-Za-z0-9_])@(all|everyone)([^A-Za-z0-9_]|$)' THEN
    RETURN 0;
  END IF;
  INSERT INTO message_announcements (message_id) VALUES (p_message_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT coalesce(display_name, username, 'Someone') INTO v_sender FROM profiles WHERE id = auth.uid();
  INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, actor_id, workspace_id)
  SELECT cm.user_id, 'announcement',
         left(coalesce(v_sender, 'Someone') || ' notified everyone in #' || v_channel.name, 300),
         left(v_msg.content, 500),
         '/channels/' || v_channel.id || CASE WHEN v_msg.parent_id IS NOT NULL THEN '?thread=' || v_msg.parent_id ELSE '' END,
         'messaging', 'message', v_msg.id, auth.uid(), v_channel.workspace_id
  FROM channel_members cm
  WHERE cm.channel_id = v_channel.id AND cm.user_id <> auth.uid()
    AND user_is_workspace_member(v_channel.workspace_id, cm.user_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE message_announcements SET notified = v_count WHERE message_id = p_message_id;
  RETURN v_count;
END $$;

-- Announcements are pushed like task assignments and approvals.
CREATE OR REPLACE FUNCTION public.notifications_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('app_changes', json_build_object('table', 'notifications', 'event', 'INSERT', 'id', NEW.id)::text);
  IF NEW.type IN ('task_assigned', 'task_approval', 'announcement') AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = NEW.user_id) THEN
    PERFORM enqueue_job('notification.push', NEW.workspace_id, NEW.user_id, jsonb_build_object('notification_id', NEW.id),
                        'push:' || NEW.id, now(), 3);
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION public.notify_channel_everyone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify_channel_everyone(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.notifications_after_insert() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
