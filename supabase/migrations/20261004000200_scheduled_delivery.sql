-- ============================================================================
-- 20261004000200_scheduled_delivery.sql
-- ----------------------------------------------------------------------------
-- One authoritative, transactional delivery path for scheduled messages.
--
-- Before: a browser poll (leader tab) and pg_cron both delivered messages.
-- Both marked sent = true before sending; the browser lost the message when the
-- send failed after the claim, the SQL path swallowed attachment failures and
-- then deleted the scheduled attachments, and neither rechecked access.
--
-- Now:
--   * deliver_scheduled_message(id) locks the row (SKIP LOCKED), rechecks that
--     the sender is still a member of the destination, inserts the message and
--     all attachments, and marks the row sent - in one subtransaction. Any
--     failure rolls everything back and schedules a retry with backoff; after
--     5 attempts the row becomes 'failed' and the sender is notified.
--   * pg_cron calls send_due_scheduled_messages() every minute (browser closed
--     is fine). Signed-in clients may also call deliver_my_due_scheduled_messages()
--     as a fallback; it runs the same function, so it cannot double-send.
--   * Rows the client is still uploading attachments for stay in 'draft' and
--     are not delivered until the client marks them 'pending'.
-- ============================================================================

ALTER TABLE scheduled_messages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_messages_status_check') THEN
    ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
      CHECK (status IN ('draft', 'pending', 'sent', 'failed', 'cancelled'));
  END IF;
END $$;

-- Backfill: rows already delivered keep their state.
UPDATE scheduled_messages SET status = 'sent' WHERE sent = true AND status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages (scheduled_at) WHERE status = 'pending';

-- Clients may edit their own rows but never fake delivery state.
CREATE OR REPLACE FUNCTION public.scheduled_messages_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'pending') THEN NEW.status := 'pending'; END IF;
    NEW.sent := false; NEW.attempts := 0; NEW.sent_message_id := NULL; NEW.sent_at := NULL; NEW.last_error := NULL;
    RETURN NEW;
  END IF;
  IF OLD.status = 'sent' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at) THEN
    RAISE EXCEPTION 'A sent message cannot be rescheduled; resend it instead' USING ERRCODE = '42501';
  END IF;
  IF NEW.sent_message_id IS DISTINCT FROM OLD.sent_message_id OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
     OR NEW.attempts IS DISTINCT FROM OLD.attempts OR (NEW.sent AND NOT OLD.sent)
     OR (NEW.status = 'sent' AND OLD.status <> 'sent') THEN
    RAISE EXCEPTION 'Delivery state is managed by the server' USING ERRCODE = '42501';
  END IF;
  -- Editing a failed message (or retrying it) re-queues it.
  IF OLD.status = 'failed' AND NEW.status IN ('pending', 'failed')
     AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.status = 'pending') THEN
    NEW.status := 'pending'; NEW.attempts := 0; NEW.next_attempt_at := NULL; NEW.last_error := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_scheduled_messages_guard ON scheduled_messages;
CREATE TRIGGER trg_scheduled_messages_guard
  BEFORE INSERT OR UPDATE ON scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION public.scheduled_messages_guard();

-- Core delivery. Returns 'sent', 'retry', 'failed', 'skipped' or 'locked'.
CREATE OR REPLACE FUNCTION public.deliver_scheduled_message(p_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  msg scheduled_messages%ROWTYPE;
  v_channel uuid;
  v_message_id uuid;
  v_error text;
  v_terminal boolean := false;
  v_channel_name text;
BEGIN
  SELECT * INTO msg FROM scheduled_messages WHERE id = p_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN 'locked'; END IF;
  IF msg.status <> 'pending' OR msg.scheduled_at > now()
     OR (msg.next_attempt_at IS NOT NULL AND msg.next_attempt_at > now()) THEN
    RETURN 'skipped';
  END IF;

  BEGIN
    v_channel := msg.channel_id;
    IF v_channel IS NULL AND msg.conversation_id IS NOT NULL THEN
      SELECT channel_id INTO v_channel FROM direct_conversations WHERE id = msg.conversation_id;
    END IF;
    IF v_channel IS NULL THEN
      v_terminal := true;
      RAISE EXCEPTION 'The destination conversation no longer exists';
    END IF;
    IF NOT user_is_channel_member(v_channel, msg.user_id) THEN
      v_terminal := true;
      RAISE EXCEPTION 'You no longer have access to the destination';
    END IF;
    IF msg.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM messages WHERE id = msg.parent_id AND channel_id = v_channel AND deleted_at IS NULL) THEN
      v_terminal := true;
      RAISE EXCEPTION 'The thread this reply belongs to was deleted';
    END IF;

    INSERT INTO messages (channel_id, user_id, content, parent_id, link_mode)
    VALUES (v_channel, msg.user_id, msg.content, msg.parent_id, msg.link_mode)
    RETURNING id INTO v_message_id;

    INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url, sort_order)
    SELECT v_message_id, a.user_id, a.file_name, a.file_size, a.file_type, a.file_url,
           row_number() OVER (ORDER BY a.created_at, a.id)
    FROM scheduled_message_attachments a
    WHERE a.scheduled_message_id = msg.id;

    UPDATE scheduled_messages
    SET status = 'sent', sent = true, sent_message_id = v_message_id, sent_at = now(),
        attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL, updated_at = now()
    WHERE id = msg.id;
    RETURN 'sent';
  EXCEPTION WHEN OTHERS THEN
    v_error := left(SQLERRM, 500);
  END;

  -- The subtransaction rolled back: nothing was posted. Record the failure.
  UPDATE scheduled_messages
  SET attempts = attempts + 1,
      last_error = v_error,
      status = CASE WHEN v_terminal OR attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
      next_attempt_at = CASE WHEN v_terminal OR attempts + 1 >= 5 THEN NULL
                             ELSE now() + (interval '1 minute' * power(2, attempts)) END,
      updated_at = now()
  WHERE id = msg.id;

  IF v_terminal OR msg.attempts + 1 >= 5 THEN
    SELECT name INTO v_channel_name FROM channels WHERE id = v_channel;
    INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, workspace_id)
    SELECT msg.user_id, 'system', 'Scheduled message not sent',
           'A message scheduled for ' || to_char(msg.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC could not be sent: ' || v_error,
           '/calendar', 'messaging', 'message', NULL, c.workspace_id
    FROM (SELECT v_channel AS id) x LEFT JOIN channels c ON c.id = x.id;
    RETURN 'failed';
  END IF;
  RETURN 'retry';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.deliver_scheduled_message(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deliver_scheduled_message(uuid) TO service_role;

-- pg_cron worker: processes due rows in order; concurrent workers skip rows
-- another worker holds, so a message is never posted twice.
CREATE OR REPLACE FUNCTION public.send_due_scheduled_messages()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE r record; v_sent integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM scheduled_messages
    WHERE status = 'pending' AND scheduled_at <= now()
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY scheduled_at
    LIMIT 200
  LOOP
    IF deliver_scheduled_message(r.id) = 'sent' THEN v_sent := v_sent + 1; END IF;
  END LOOP;
  RETURN v_sent;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.send_due_scheduled_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_due_scheduled_messages() TO service_role;

-- Fallback for projects without pg_cron: a signed-in client may trigger
-- delivery of its own due messages. Same transactional path.
CREATE OR REPLACE FUNCTION public.deliver_my_due_scheduled_messages()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE r record; v_sent integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RETURN 0; END IF;
  FOR r IN
    SELECT id FROM scheduled_messages
    WHERE user_id = auth.uid() AND status = 'pending' AND scheduled_at <= now()
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY scheduled_at
    LIMIT 50
  LOOP
    IF deliver_scheduled_message(r.id) = 'sent' THEN v_sent := v_sent + 1; END IF;
  END LOOP;
  RETURN v_sent;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.deliver_my_due_scheduled_messages() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deliver_my_due_scheduled_messages() TO authenticated;

-- "Resend" a delivered message: queue a copy due now (with the same
-- attachments) and deliver it through the same path.
CREATE OR REPLACE FUNCTION public.resend_scheduled_message(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE src scheduled_messages%ROWTYPE; v_new uuid := gen_random_uuid(); v_result text;
BEGIN
  SELECT * INTO src FROM scheduled_messages WHERE id = p_id AND user_id = auth.uid();
  IF src.id IS NULL THEN RAISE EXCEPTION 'Scheduled message not found' USING ERRCODE = '42501'; END IF;
  INSERT INTO scheduled_messages (id, user_id, channel_id, conversation_id, parent_id, content, link_mode, scheduled_at, status, sent)
  VALUES (v_new, src.user_id, src.channel_id, src.conversation_id, src.parent_id, src.content, src.link_mode, now(), 'pending', false);
  INSERT INTO scheduled_message_attachments (scheduled_message_id, user_id, file_name, file_size, file_type, file_url)
  SELECT v_new, a.user_id, a.file_name, a.file_size, a.file_type, a.file_url
  FROM scheduled_message_attachments a WHERE a.scheduled_message_id = src.id;
  IF NOT EXISTS (SELECT 1 FROM scheduled_message_attachments WHERE scheduled_message_id = v_new) AND src.sent_message_id IS NOT NULL THEN
    INSERT INTO scheduled_message_attachments (scheduled_message_id, user_id, file_name, file_size, file_type, file_url)
    SELECT v_new, src.user_id, f.file_name, f.file_size, f.file_type, f.file_url
    FROM file_attachments f WHERE f.message_id = src.sent_message_id;
  END IF;
  v_result := deliver_scheduled_message(v_new);
  RETURN v_new;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.resend_scheduled_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resend_scheduled_message(uuid) TO authenticated;

-- Promote a draft to pending once its attachments are uploaded.
CREATE OR REPLACE FUNCTION public.queue_scheduled_message(p_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  UPDATE scheduled_messages SET status = 'pending', updated_at = now()
  WHERE id = p_id AND user_id = auth.uid() AND status = 'draft';
$$;
REVOKE EXECUTE ON FUNCTION public.queue_scheduled_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.queue_scheduled_message(uuid) TO authenticated;

-- Abandoned drafts (upload never finished) become failed after an hour so the
-- sender sees them instead of waiting forever.
CREATE OR REPLACE FUNCTION public.expire_stale_scheduled_drafts()
RETURNS integer
LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  WITH expired AS (
    UPDATE scheduled_messages
    SET status = 'failed', last_error = 'Attachments did not finish uploading', updated_at = now()
    WHERE status = 'draft' AND created_at < now() - interval '1 hour'
    RETURNING id
  ) SELECT count(*)::integer FROM expired;
$$;
REVOKE EXECUTE ON FUNCTION public.expire_stale_scheduled_drafts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_scheduled_drafts() TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-due-scheduled-messages') THEN
      PERFORM cron.schedule('send-due-scheduled-messages', '* * * * *', 'SELECT public.send_due_scheduled_messages();');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-stale-scheduled-drafts') THEN
      PERFORM cron.schedule('expire-stale-scheduled-drafts', '*/15 * * * *', 'SELECT public.expire_stale_scheduled_drafts();');
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
