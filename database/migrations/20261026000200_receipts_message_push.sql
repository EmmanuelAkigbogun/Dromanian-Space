-- ============================================================================
-- 20261026000200_receipts_message_push.sql
-- ----------------------------------------------------------------------------
-- Delivered and read receipts, and push for direct messages and mentions.
--
-- Each channel member (direct conversations have members too) keeps how far
-- they have received (last_delivered_at: their app was running, or a push
-- reached one of their devices) and read (last_read_at: the conversation was
-- on screen). A message is delivered/read once every other member is past it.
-- Changes are announced on app_changes so senders see them live.
--
-- Direct messages are pushed to the other participants (unless they muted the
-- conversation or already read it), and @mentions are pushed like task
-- assignments, approvals and announcements.
-- ============================================================================

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS last_delivered_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages (channel_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.announce_channel_member(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pg_notify('app_changes', json_build_object('table', 'channel_members', 'event', 'UPDATE', 'id', p_id)::text);
$$;

-- The caller has received (and, with p_read, read) this conversation up to
-- p_up_to (the newest message they have; never later than now).
CREATE OR REPLACE FUNCTION public.mark_channel_seen(p_channel_id uuid, p_up_to timestamptz, p_read boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_at timestamptz := least(coalesce(p_up_to, now()), now()); v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  UPDATE channel_members
     SET last_delivered_at = greatest(coalesce(last_delivered_at, '-infinity'), v_at),
         last_read_at = CASE WHEN p_read THEN greatest(coalesce(last_read_at, '-infinity'), v_at) ELSE last_read_at END
   WHERE channel_id = p_channel_id AND user_id = v_uid
     AND (coalesce(last_delivered_at, '-infinity') < v_at OR (p_read AND coalesce(last_read_at, '-infinity') < v_at))
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN PERFORM announce_channel_member(v_id); END IF;
END $$;

-- The caller's app is running: everything sent to them so far has arrived.
CREATE OR REPLACE FUNCTION public.mark_all_delivered()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid; v_n integer := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN 0; END IF;
  FOR v_id IN
    UPDATE channel_members cm SET last_delivered_at = now()
     WHERE cm.user_id = v_uid
       AND EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = cm.channel_id AND m.user_id <> v_uid AND m.deleted_at IS NULL
                     AND m.created_at > greatest(coalesce(cm.last_delivered_at, '-infinity'), coalesce(cm.last_read_at, '-infinity')))
    RETURNING cm.id
  LOOP
    PERFORM announce_channel_member(v_id); v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Where each member of a conversation is, for the sender's ticks.
CREATE OR REPLACE FUNCTION public.channel_receipts(p_channel_id uuid)
RETURNS TABLE (user_id uuid, last_delivered_at timestamptz, last_read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cm.user_id, greatest(cm.last_delivered_at, cm.last_read_at), cm.last_read_at
    FROM channel_members cm
   WHERE cm.channel_id = p_channel_id
     AND EXISTS (SELECT 1 FROM channel_members me WHERE me.channel_id = p_channel_id AND me.user_id = auth.uid());
$$;

-- Push direct messages to the other participants.
CREATE OR REPLACE FUNCTION public.messages_push_direct() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM direct_conversations WHERE channel_id = NEW.channel_id) THEN RETURN NEW; END IF;
  FOR v_user IN
    SELECT cm.user_id FROM channel_members cm
     WHERE cm.channel_id = NEW.channel_id AND cm.user_id <> NEW.user_id AND NOT cm.muted
       AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = cm.user_id)
  LOOP
    PERFORM enqueue_job('message.push', NEW.workspace_id, v_user,
                        jsonb_build_object('message_id', NEW.id, 'user_id', v_user),
                        'push:msg:' || NEW.id || ':' || v_user, now(), 3);
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_messages_push_direct ON messages;
CREATE TRIGGER trg_messages_push_direct AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_push_direct();

-- Mentions are pushed too.
CREATE OR REPLACE FUNCTION public.notifications_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('app_changes', json_build_object('table', 'notifications', 'event', 'INSERT', 'id', NEW.id)::text);
  IF NEW.type IN ('task_assigned', 'task_approval', 'announcement', 'mention') AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = NEW.user_id) THEN
    PERFORM enqueue_job('notification.push', NEW.workspace_id, NEW.user_id, jsonb_build_object('notification_id', NEW.id),
                        'push:' || NEW.id, now(), 3);
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.announce_channel_member(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messages_push_direct() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_channel_seen(uuid, timestamptz, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_all_delivered() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.channel_receipts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_channel_seen(uuid, timestamptz, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_delivered() TO authenticated;
GRANT EXECUTE ON FUNCTION public.channel_receipts(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
