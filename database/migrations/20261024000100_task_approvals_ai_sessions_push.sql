-- ============================================================================
-- 20261024000100_task_approvals_ai_sessions_push.sql
-- ----------------------------------------------------------------------------
--   * Project managers: a workspace-level designation chosen by owners/admins.
--     They approve tasks that agents extract; with none chosen, owners and
--     admins approve.
--   * Task requests: tasks an agent prepared from a conversation or pasted
--     text, waiting for a project manager. Nothing is created until approved.
--   * Scribe: a note-taker agent that turns conversations and lists into
--     task requests, and takes notes in direct-message AI sessions.
--   * AI sessions: participants of a direct conversation invite Scribe; it
--     reads only the messages sent while the session is active and posts
--     notes when someone finishes the session.
--   * Assignment notifications are created by the database for every
--     assignment path, and task notifications are sent as Web Push to the
--     devices people enabled.
--   * Change feed: rows written by database functions (notifications, agent
--     replies, sessions, task requests) are announced with pg_notify so the
--     API can stream them live; the data proxy only sees direct writes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Project managers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_project_managers (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
ALTER TABLE workspace_project_managers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workspace_project_managers_read" ON workspace_project_managers;
CREATE POLICY "workspace_project_managers_read" ON workspace_project_managers FOR SELECT TO authenticated
  USING (public.user_is_workspace_member(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON workspace_project_managers FROM anon, authenticated;

-- Who approves task requests: the chosen project managers who are still
-- members, or the owners and admins when none are chosen.
CREATE OR REPLACE FUNCTION public.task_approver_ids(p_workspace_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH managers AS (
    SELECT pm.user_id FROM workspace_project_managers pm
    JOIN workspace_members wm ON wm.workspace_id = pm.workspace_id AND wm.user_id = pm.user_id
    WHERE pm.workspace_id = p_workspace_id
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM managers) THEN ARRAY(SELECT user_id FROM managers)
    ELSE ARRAY(SELECT user_id FROM workspace_members WHERE workspace_id = p_workspace_id AND role IN ('owner', 'admin'))
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_task_approver(p_workspace_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_user_id = ANY(task_approver_ids(p_workspace_id));
$$;

CREATE OR REPLACE FUNCTION public.set_project_manager(p_workspace_id uuid, p_user_id uuid, p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace owners and admins can choose project managers' USING ERRCODE = '42501';
  END IF;
  IF p_enabled THEN
    IF NOT user_is_workspace_member(p_workspace_id, p_user_id) THEN
      RAISE EXCEPTION 'That person is not a member of this workspace' USING ERRCODE = '22023';
    END IF;
    INSERT INTO workspace_project_managers (workspace_id, user_id, assigned_by)
    VALUES (p_workspace_id, p_user_id, auth.uid())
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM workspace_project_managers WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
  END IF;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, auth.uid(), CASE WHEN p_enabled THEN 'project_manager_added' ELSE 'project_manager_removed' END,
          'user', p_user_id, '{}'::jsonb);
  RETURN p_enabled;
END $$;

CREATE OR REPLACE FUNCTION public.on_workspace_member_removed_project_manager() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM workspace_project_managers WHERE workspace_id = OLD.workspace_id AND user_id = OLD.user_id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_workspace_member_removed_project_manager ON workspace_members;
CREATE TRIGGER trg_workspace_member_removed_project_manager AFTER DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.on_workspace_member_removed_project_manager();

-- ---------------------------------------------------------------------------
-- Task requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  description text CHECK (description IS NULL OR length(description) <= 8000),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_date timestamptz,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  assignee_ids uuid[] NOT NULL DEFAULT '{}',
  source_channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  -- Where the request came from, in words ("#general", "an AI session in a direct message").
  source_label text CHECK (source_label IS NULL OR length(source_label) <= 200),
  submitted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_task_requests_pending ON task_requests (workspace_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_task_requests_submitter ON task_requests (submitted_by, created_at DESC);
ALTER TABLE task_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "task_requests_read" ON task_requests;
CREATE POLICY "task_requests_read" ON task_requests FOR SELECT TO authenticated
  USING (user_is_workspace_member(workspace_id, auth.uid())
         AND (submitted_by = auth.uid() OR public.is_task_approver(workspace_id, auth.uid())));
REVOKE INSERT, UPDATE, DELETE ON task_requests FROM anon, authenticated;

-- Called by the agent tool. Assignees and projects were resolved for the
-- requester; they are checked again here and when a manager approves.
CREATE OR REPLACE FUNCTION public.agent_submit_task_requests(p_run_id uuid, p_tool_use_id text, p_tasks jsonb, p_source_label text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run agent_runs%ROWTYPE; v_task jsonb; v_i integer := 0; v_new integer := 0; v_id uuid; v_ids uuid[] := '{}';
  v_assignees uuid[]; v_project uuid; v_channel uuid; v_approvers uuid[]; v_agent text; v_requester text; v_key text;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000'; END IF;
  IF jsonb_typeof(p_tasks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tasks) NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'Submit between 1 and 25 tasks' USING ERRCODE = '22023';
  END IF;
  v_channel := nullif(v_run.scope ->> 'channel_id', '')::uuid;
  IF v_channel IS NOT NULL AND NOT user_is_channel_member(v_channel, v_run.requested_by) THEN v_channel := NULL; END IF;

  FOR v_task IN SELECT value FROM jsonb_array_elements(p_tasks) LOOP
    v_i := v_i + 1;
    v_assignees := ARRAY(SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(coalesce(v_task -> 'assignee_ids', '[]'::jsonb)) x);
    IF EXISTS (SELECT 1 FROM unnest(v_assignees) u WHERE NOT user_is_workspace_member(v_run.workspace_id, u)) THEN
      RAISE EXCEPTION 'An assignee is not a workspace member' USING ERRCODE = '42501';
    END IF;
    v_project := nullif(v_task ->> 'project_id', '')::uuid;
    IF v_project IS NOT NULL AND (get_project_workspace_id(v_project) IS DISTINCT FROM v_run.workspace_id
       OR NOT is_project_readable(v_project, v_run.requested_by)) THEN
      RAISE EXCEPTION 'The requester cannot open that project' USING ERRCODE = '42501';
    END IF;
    v_key := 'agent:' || p_run_id || ':' || p_tool_use_id || ':' || v_i;
    v_id := NULL;
    INSERT INTO task_requests (workspace_id, title, description, priority, due_date, project_id, assignee_ids, source_channel_id,
                               source_label, submitted_by, agent_id, agent_run_id, idempotency_key)
    VALUES (v_run.workspace_id, left(btrim(v_task ->> 'title'), 300), left(nullif(btrim(v_task ->> 'description'), ''), 8000),
            coalesce(nullif(v_task ->> 'priority', ''), 'medium'), nullif(v_task ->> 'due_date', '')::timestamptz, v_project,
            v_assignees, v_channel, left(nullif(btrim(p_source_label), ''), 200), v_run.requested_by, v_run.agent_id, p_run_id, v_key)
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM task_requests WHERE workspace_id = v_run.workspace_id AND idempotency_key = v_key;
    ELSE
      v_new := v_new + 1;
    END IF;
    v_ids := v_ids || v_id;
  END LOOP;

  v_approvers := task_approver_ids(v_run.workspace_id);
  IF v_new > 0 THEN
    SELECT name INTO v_agent FROM workspace_agents WHERE id = v_run.agent_id;
    SELECT coalesce(display_name, username) INTO v_requester FROM profiles WHERE id = v_run.requested_by;
    INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, actor_id, workspace_id)
    SELECT u, 'task_approval',
           v_new || CASE WHEN v_new = 1 THEN ' task needs' ELSE ' tasks need' END || ' your approval',
           left(coalesce(v_agent, 'An agent') || ' prepared ' || v_new || CASE WHEN v_new = 1 THEN ' task' ELSE ' tasks' END
                || ' for ' || coalesce(v_requester, 'a member') || coalesce(' from ' || nullif(btrim(p_source_label), ''), '') || '.', 1000),
           '/tasks?view=approvals', 'tasks', 'task', v_run.requested_by, v_run.workspace_id
    FROM unnest(v_approvers) u
    WHERE u <> v_run.requested_by;
  END IF;
  RETURN jsonb_build_object('status', 'submitted', 'request_ids', to_jsonb(v_ids), 'new', v_new,
                            'approvers', coalesce(array_length(v_approvers, 1), 0),
                            'requester_is_approver', v_run.requested_by = ANY(v_approvers));
END $$;

-- A project manager approves (optionally with edits) or rejects a request.
-- Approval creates the task as the manager; repeated decisions are no-ops.
CREATE OR REPLACE FUNCTION public.decide_task_request(p_request_id uuid, p_approve boolean, p_changes jsonb DEFAULT '{}'::jsonb,
  p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  r task_requests%ROWTYPE; v_actor uuid := auth.uid(); v_task uuid; v_title text; v_description text; v_priority text;
  v_due timestamptz; v_project uuid; v_assignees uuid[]; v_user uuid; v_channel uuid; v_note text;
BEGIN
  SELECT * INTO r FROM task_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL OR NOT user_is_workspace_member(r.workspace_id, v_actor) OR NOT is_task_approver(r.workspace_id, v_actor) THEN
    RAISE EXCEPTION 'Task request not found' USING ERRCODE = '42501';
  END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('status', r.status, 'task_id', r.task_id);
  END IF;
  v_note := left(nullif(btrim(p_note), ''), 1000);

  IF NOT p_approve THEN
    UPDATE task_requests SET status = 'rejected', decided_by = v_actor, decided_at = now(), decision_note = v_note, updated_at = now()
    WHERE id = r.id;
    IF r.submitted_by <> v_actor THEN
      INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, actor_id, workspace_id)
      VALUES (r.submitted_by, 'system', left('Task not approved: ' || r.title, 300),
              coalesce(v_note, 'A project manager declined this task request.'),
              '/tasks?view=approvals', 'tasks', 'task', v_actor, r.workspace_id);
    END IF;
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  p_changes := coalesce(p_changes, '{}'::jsonb);
  v_title := btrim(coalesce(p_changes ->> 'title', r.title));
  IF length(v_title) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'The title must be 1 to 300 characters' USING ERRCODE = '22023'; END IF;
  v_description := CASE WHEN p_changes ? 'description' THEN left(nullif(btrim(p_changes ->> 'description'), ''), 8000) ELSE r.description END;
  v_priority := coalesce(nullif(p_changes ->> 'priority', ''), r.priority);
  IF v_priority NOT IN ('low', 'medium', 'high', 'urgent') THEN RAISE EXCEPTION 'Unknown priority' USING ERRCODE = '22023'; END IF;
  v_due := CASE WHEN p_changes ? 'due_date' THEN nullif(p_changes ->> 'due_date', '')::timestamptz ELSE r.due_date END;
  v_project := CASE WHEN p_changes ? 'project_id' THEN nullif(p_changes ->> 'project_id', '')::uuid ELSE r.project_id END;
  v_assignees := CASE WHEN p_changes ? 'assignee_ids'
    THEN ARRAY(SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(coalesce(p_changes -> 'assignee_ids', '[]'::jsonb)) x)
    ELSE r.assignee_ids END;
  IF v_project IS NOT NULL AND (get_project_workspace_id(v_project) IS DISTINCT FROM r.workspace_id
     OR NOT is_project_editor(v_project, v_actor)) THEN
    RAISE EXCEPTION 'You cannot add tasks to that project' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_assignees) u WHERE NOT user_is_workspace_member(r.workspace_id, u)) THEN
    RAISE EXCEPTION 'An assignee is no longer a workspace member' USING ERRCODE = '42501';
  END IF;
  v_channel := CASE WHEN user_is_channel_member(r.source_channel_id, v_actor) THEN r.source_channel_id END;

  INSERT INTO tasks (workspace_id, title, description, priority, due_date, project_id, channel_id, created_by)
  VALUES (r.workspace_id, v_title, v_description, v_priority, v_due, v_project, v_channel, v_actor)
  RETURNING id INTO v_task;
  FOREACH v_user IN ARRAY v_assignees LOOP
    INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES (v_task, v_user, v_actor) ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO task_activity (task_id, user_id, action, details)
  VALUES (v_task, v_actor, 'created', jsonb_build_object('source', 'task_request', 'request_id', r.id,
          'submitted_by', r.submitted_by, 'agent_run_id', r.agent_run_id));
  UPDATE task_requests SET status = 'approved', decided_by = v_actor, decided_at = now(), decision_note = v_note, task_id = v_task,
    title = v_title, description = v_description, priority = v_priority, due_date = v_due, project_id = v_project,
    assignee_ids = v_assignees, updated_at = now()
  WHERE id = r.id;
  IF r.submitted_by <> v_actor AND NOT r.submitted_by = ANY(v_assignees) THEN
    INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, actor_id, workspace_id)
    VALUES (r.submitted_by, 'system', left('Task approved: ' || v_title, 300), 'A project manager approved this task.',
            '/tasks/' || v_task, 'tasks', 'task', v_task, v_actor, r.workspace_id);
  END IF;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (r.workspace_id, v_actor, 'task_request_approved', 'task', v_task, jsonb_build_object('request_id', r.id));
  RETURN jsonb_build_object('status', 'approved', 'task_id', v_task);
END $$;

-- ---------------------------------------------------------------------------
-- Assignment notifications (every path: dialogs, imports, duplicates, agents)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_task_assignee() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_task tasks%ROWTYPE; v_actor uuid := coalesce(NEW.assigned_by, auth.uid()); v_name text;
BEGIN
  IF NEW.user_id = v_actor THEN RETURN NEW; END IF;
  SELECT * INTO v_task FROM tasks WHERE id = NEW.task_id;
  IF v_task.id IS NULL OR v_task.deleted_at IS NOT NULL OR v_task.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT coalesce(display_name, username) INTO v_name FROM profiles WHERE id = v_actor;
  INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, actor_id, workspace_id)
  VALUES (NEW.user_id, 'task_assigned', left('You were assigned to: ' || v_task.title, 300),
          left(coalesce(v_name, 'Someone') || ' assigned you to the task "' || v_task.title || '"', 1000),
          '/tasks/' || v_task.id, 'tasks', 'task', v_task.id, v_actor, v_task.workspace_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'assignment notification failed task=% err=%', NEW.task_id, SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_notify_task_assignee ON task_assignees;
CREATE TRIGGER trg_notify_task_assignee AFTER INSERT ON task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.notify_task_assignee();

-- ---------------------------------------------------------------------------
-- Web Push subscriptions (written by the API; owners can list and remove)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND length(endpoint) <= 2048),
  p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 40 AND 200),
  auth text NOT NULL CHECK (length(auth) BETWEEN 10 AND 100),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failures integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "push_subscriptions_read_own" ON push_subscriptions;
CREATE POLICY "push_subscriptions_read_own" ON push_subscriptions FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "push_subscriptions_delete_own" ON push_subscriptions;
CREATE POLICY "push_subscriptions_delete_own" ON push_subscriptions FOR DELETE TO authenticated USING (user_id = auth.uid());
REVOKE INSERT, UPDATE ON push_subscriptions FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Change feed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_change_feed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('app_changes', json_build_object('table', TG_TABLE_NAME, 'event', TG_OP, 'id', NEW.id)::text);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.notifications_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('app_changes', json_build_object('table', 'notifications', 'event', 'INSERT', 'id', NEW.id)::text);
  IF NEW.type IN ('task_assigned', 'task_approval') AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = NEW.user_id) THEN
    PERFORM enqueue_job('notification.push', NEW.workspace_id, NEW.user_id, jsonb_build_object('notification_id', NEW.id),
                        'push:' || NEW.id, now(), 3);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_notifications_after_insert ON notifications;
CREATE TRIGGER trg_notifications_after_insert AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_after_insert();

-- Members' own messages reach the feed through the data proxy; agent replies
-- are written by database functions.
DROP TRIGGER IF EXISTS trg_messages_agent_change_feed ON messages;
CREATE TRIGGER trg_messages_agent_change_feed AFTER INSERT ON messages
  FOR EACH ROW WHEN (NEW.agent_id IS NOT NULL) EXECUTE FUNCTION public.app_change_feed();

DROP TRIGGER IF EXISTS trg_task_requests_change_feed ON task_requests;
CREATE TRIGGER trg_task_requests_change_feed AFTER INSERT OR UPDATE ON task_requests
  FOR EACH ROW EXECUTE FUNCTION public.app_change_feed();

-- ---------------------------------------------------------------------------
-- AI sessions in direct conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_ai_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  started_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  message_count integer,
  notes_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_ai_sessions_active ON conversation_ai_sessions (channel_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversation_ai_sessions_channel ON conversation_ai_sessions (channel_id, started_at DESC);
ALTER TABLE conversation_ai_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "conversation_ai_sessions_read" ON conversation_ai_sessions;
CREATE POLICY "conversation_ai_sessions_read" ON conversation_ai_sessions FOR SELECT TO authenticated
  USING (public.user_is_channel_member(channel_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON conversation_ai_sessions FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_conversation_ai_sessions_change_feed ON conversation_ai_sessions;
CREATE TRIGGER trg_conversation_ai_sessions_change_feed AFTER INSERT OR UPDATE ON conversation_ai_sessions
  FOR EACH ROW EXECUTE FUNCTION public.app_change_feed();

-- Starts (or returns the already active) session. Only direct conversations.
CREATE OR REPLACE FUNCTION public.ai_session_start(p_actor uuid, p_channel_id uuid, p_agent_id uuid)
RETURNS conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_session conversation_ai_sessions%ROWTYPE; v_workspace uuid; v_agent workspace_agents%ROWTYPE;
BEGIN
  SELECT workspace_id INTO v_workspace FROM direct_conversations WHERE channel_id = p_channel_id;
  IF v_workspace IS NULL OR NOT user_is_channel_member(p_channel_id, p_actor) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_agent FROM workspace_agents WHERE id = p_agent_id AND workspace_id = v_workspace;
  IF v_agent.id IS NULL OR v_agent.archived_at IS NOT NULL OR NOT agent_visible_to(v_agent.id, p_actor) THEN
    RAISE EXCEPTION 'Agent not found' USING ERRCODE = '42501';
  END IF;
  IF v_agent.status <> 'active' THEN RAISE EXCEPTION 'This agent is disabled' USING ERRCODE = '55000'; END IF;
  IF NOT (ai_settings_for(v_workspace)).enabled THEN RAISE EXCEPTION 'AI is turned off for this workspace' USING ERRCODE = '55000'; END IF;
  SELECT * INTO v_session FROM conversation_ai_sessions WHERE channel_id = p_channel_id AND status = 'active';
  IF v_session.id IS NOT NULL THEN RETURN v_session; END IF;
  INSERT INTO conversation_ai_sessions (workspace_id, channel_id, agent_id, started_by)
  VALUES (v_workspace, p_channel_id, v_agent.id, p_actor)
  ON CONFLICT (channel_id) WHERE status = 'active' DO NOTHING
  RETURNING * INTO v_session;
  IF v_session.id IS NULL THEN
    SELECT * INTO v_session FROM conversation_ai_sessions WHERE channel_id = p_channel_id AND status = 'active';
  END IF;
  RETURN v_session;
END $$;

-- Ends a session; any participant may finish it. Repeats return the ended row.
CREATE OR REPLACE FUNCTION public.ai_session_finish(p_actor uuid, p_session_id uuid)
RETURNS conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_session conversation_ai_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM conversation_ai_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_session.id IS NULL OR NOT user_is_channel_member(v_session.channel_id, p_actor) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF v_session.status = 'active' THEN
    UPDATE conversation_ai_sessions SET status = 'finished', ended_by = p_actor, ended_at = now(),
      message_count = (SELECT count(*) FROM messages m
                       WHERE m.channel_id = v_session.channel_id AND m.deleted_at IS NULL AND m.agent_id IS NULL
                         AND m.created_at >= v_session.started_at AND m.created_at <= now())
    WHERE id = p_session_id
    RETURNING * INTO v_session;
  END IF;
  RETURN v_session;
END $$;

CREATE OR REPLACE FUNCTION public.ai_session_attach_run(p_session_id uuid, p_run_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE conversation_ai_sessions SET notes_run_id = p_run_id WHERE id = p_session_id AND notes_run_id IS NULL;
$$;

-- The messages the agent may read for a session: exactly those sent while it
-- was active, for a requester who is still in the conversation.
CREATE OR REPLACE FUNCTION public.ai_session_transcript_for(p_actor uuid, p_session_id uuid)
RETURNS TABLE(id uuid, author_name text, is_agent boolean, content text, created_at timestamptz, parent_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_session conversation_ai_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM conversation_ai_sessions WHERE conversation_ai_sessions.id = p_session_id;
  IF v_session.id IS NULL OR NOT user_is_channel_member(v_session.channel_id, p_actor) THEN RETURN; END IF;
  RETURN QUERY
  SELECT * FROM (
    SELECT m.id,
      coalesce(a.name || ' (agent)', pr.display_name, pr.username, 'Someone')::text,
      m.agent_id IS NOT NULL, m.content, m.created_at, m.parent_id
    FROM messages m
    LEFT JOIN profiles pr ON pr.id = m.user_id
    LEFT JOIN workspace_agents a ON a.id = m.agent_id
    WHERE m.channel_id = v_session.channel_id AND m.deleted_at IS NULL
      AND m.created_at >= v_session.started_at AND m.created_at <= coalesce(v_session.ended_at, now())
    ORDER BY m.created_at DESC
    LIMIT 500
  ) recent ORDER BY 5;
END $$;

-- ---------------------------------------------------------------------------
-- Agents: Scribe, its tool, session-notes runs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_known_tools()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_conversation', 'list_tasks',
               'read_crm_record', 'compute_csv_metrics', 'web_search',
               'propose_task', 'propose_document', 'propose_channel_message', 'propose_crm_update',
               'read_calendar', 'propose_calendar_event', 'workspace_metrics', 'read_brand_kit', 'fetch_site_page',
               'read_personal_notes', 'save_personal_note', 'delegate_to_specialists', 'submit_tasks_for_approval'];
$$;

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_trigger_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_trigger_check
  CHECK (trigger IN ('interactive', 'mention', 'automation', 'thread_summary', 'delegation', 'session_notes'));

INSERT INTO public.agent_templates (
  key, name, handle, job, capability, category, description, instructions,
  default_tools, examples, color, icon, sort_order, requires, kind, connectors
)
VALUES (
  'note_taker',
  'Scribe',
  'scribe',
  'Note Taker & Task Coordinator',
  'Takes notes on conversations and turns them, or any pasted list, into tasks for your project managers to approve.',
  'Productivity',
  'Reads a channel or a direct-message AI session, writes clear notes, and prepares action items as tasks. Tasks go to the project managers for approval before they are created.',
  'You are Scribe, the workspace''s note taker and task coordinator. You turn conversations and plain text into clear notes and well-formed tasks.

When asked about a channel or conversation, read it with read_conversation (ask for up to 100 messages, and use "before" to page back when the person wants a longer period). When given a pasted list or free text, treat each actionable item as a task.

For every task:
- a short, imperative title;
- a description with the context needed to act on it, including who asked for it when it came from a conversation;
- an owner only when the material names or clearly implies one, written as their name or @username exactly as it appears;
- a due date only when one is stated or clearly implied (convert relative dates using today''s date);
- a priority only when the material indicates one; otherwise leave it out.

Never invent owners, dates or work that was not discussed. Skip items that are already done, and check list_tasks when an item may already be tracked. Merge duplicates.

Submit all tasks in one submit_tasks_for_approval call. They go to the project managers for approval and are NOT created until a manager approves them; say so plainly.

Then answer with: a short summary, key decisions, the action items you submitted (owner and due date when known), and open questions. If nothing is actionable, say so and submit nothing.',
  ARRAY['read_conversation', 'search_workspace', 'list_tasks', 'submit_tasks_for_approval'],
  ARRAY[
    'Take notes on the last day of #general and extract the tasks.',
    'Turn this list into tasks: …',
    'What did we agree on in this channel this week?'
  ],
  '#7C3AED',
  'clipboard',
  15,
  '{}',
  'specialist',
  '{}'
)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  handle = EXCLUDED.handle,
  job = EXCLUDED.job,
  capability = EXCLUDED.capability,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  instructions = EXCLUDED.instructions,
  default_tools = EXCLUDED.default_tools,
  examples = EXCLUDED.examples,
  color = EXCLUDED.color,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order,
  requires = EXCLUDED.requires,
  kind = EXCLUDED.kind,
  connectors = EXCLUDED.connectors,
  retired = false;

DO $$
DECLARE workspace record;
BEGIN
  FOR workspace IN SELECT id FROM public.workspaces LOOP
    PERFORM public.agent_seed_workspace(workspace.id, NULL);
  END LOOP;
END $$;

-- As in 20261004000800, except that session notes are always posted: the
-- participants invited the agent into the conversation for this purpose.
CREATE OR REPLACE FUNCTION public.agent_publish_reply(p_run_id uuid, p_content text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run agent_runs%ROWTYPE; v_settings workspace_ai_settings%ROWTYPE; v_args jsonb; v_gaps jsonb; v_id uuid;
  v_result jsonb; v_channel uuid; v_parent uuid; v_auto boolean;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RETURN jsonb_build_object('status', 'not_running'); END IF;
  IF coalesce(v_run.destination ->> 'type', 'private') <> 'channel' THEN RETURN jsonb_build_object('status', 'private'); END IF;
  IF length(btrim(coalesce(p_content, ''))) = 0 THEN RETURN jsonb_build_object('status', 'empty'); END IF;
  v_channel := (v_run.destination ->> 'channel_id')::uuid;
  v_parent := nullif(v_run.destination ->> 'parent_id', '')::uuid;
  IF NOT user_is_channel_member(v_channel, v_run.requested_by) THEN
    RETURN jsonb_build_object('status', 'private', 'reason', 'not_member');
  END IF;
  v_args := jsonb_build_object('channel_id', v_channel, 'parent_id', v_parent, 'content', left(p_content, 20000));
  v_gaps := agent_audience_gaps(p_run_id, agent_action_audience(v_run.workspace_id, v_run.requested_by, 'post_message', v_args));
  IF jsonb_array_length(v_gaps) > 0 THEN
    PERFORM agent_add_event(p_run_id, 'warning', jsonb_build_object('code', 'kept_private',
      'message', 'Some people in this conversation cannot open sources this answer used, so it was kept private.',
      'sources', v_gaps));
    RETURN jsonb_build_object('status', 'private', 'reason', 'audience', 'sources', v_gaps);
  END IF;
  v_settings := ai_settings_for(v_run.workspace_id);
  v_auto := v_settings.mention_reply_policy = 'auto' OR v_run.trigger = 'session_notes';
  INSERT INTO agent_action_proposals (workspace_id, run_id, conversation_id, action_type, arguments, arguments_hash, summary,
                                      destination, requested_for, idempotency_key, status)
  VALUES (v_run.workspace_id, p_run_id, v_run.conversation_id, 'post_message', v_args, agent_hash_arguments(v_args),
          CASE WHEN v_run.trigger = 'session_notes' THEN 'Post the notes of the AI session'
               ELSE 'Reply in the conversation where the agent was mentioned' END,
          jsonb_build_object('type', 'channel', 'channel_id', v_channel, 'parent_id', v_parent),
          v_run.requested_by, 'reply:' || p_run_id, CASE WHEN v_auto THEN 'executing' ELSE 'pending' END)
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('status', 'exists'); END IF;
  IF NOT v_auto THEN
    RETURN jsonb_build_object('status', 'proposed', 'proposal_id', v_id);
  END IF;
  BEGIN
    v_result := agent_execute_proposal(v_id);
    UPDATE agent_action_proposals SET status = 'executed', executed_at = now(), result = v_result,
      decided_by = v_run.requested_by, decided_at = now()
    WHERE id = v_id;
    INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (v_run.workspace_id, v_run.requested_by, 'agent_reply_published', 'agent_proposal', v_id,
            jsonb_build_object('policy', CASE WHEN v_run.trigger = 'session_notes' THEN 'session' ELSE 'auto' END,
                               'run_id', p_run_id, 'result', v_result));
    RETURN jsonb_build_object('status', 'published', 'proposal_id', v_id, 'result', v_result);
  EXCEPTION WHEN OTHERS THEN
    UPDATE agent_action_proposals SET status = 'failed', error = left(SQLERRM, 500) WHERE id = v_id;
    RETURN jsonb_build_object('status', 'failed', 'error', left(SQLERRM, 200));
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.task_approver_ids(uuid)',
    'public.agent_submit_task_requests(uuid, text, jsonb, text)',
    'public.ai_session_start(uuid, uuid, uuid)', 'public.ai_session_finish(uuid, uuid)',
    'public.ai_session_attach_run(uuid, uuid)', 'public.ai_session_transcript_for(uuid, uuid)',
    'public.agent_publish_reply(uuid, text)',
    'public.notify_task_assignee()', 'public.app_change_feed()', 'public.notifications_after_insert()',
    'public.on_workspace_member_removed_project_manager()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.is_task_approver(uuid, uuid)', 'public.set_project_manager(uuid, uuid, boolean)',
    'public.decide_task_request(uuid, boolean, jsonb, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;
GRANT SELECT ON workspace_project_managers, task_requests, push_subscriptions, conversation_ai_sessions TO authenticated;
GRANT DELETE ON push_subscriptions TO authenticated;
GRANT ALL ON workspace_project_managers, task_requests, push_subscriptions, conversation_ai_sessions TO service_role;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
