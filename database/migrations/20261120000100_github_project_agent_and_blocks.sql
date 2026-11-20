-- Blocking removed members, and the GitHub project agent: projects linked to
-- repositories, issues imported as tasks, and a weekly review that notes
-- progress on tasks, notifies their assignees and proposes status changes for
-- a project manager to approve.

-- ── Remove and block ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workspace_blocked_users (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
ALTER TABLE public.workspace_blocked_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_blocked_users_admin_read ON public.workspace_blocked_users;
CREATE POLICY workspace_blocked_users_admin_read ON public.workspace_blocked_users FOR SELECT TO authenticated
  USING (public.user_is_workspace_admin(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.workspace_blocked_users FROM anon, authenticated;
GRANT SELECT ON public.workspace_blocked_users TO authenticated;

-- Every way back in (invite link, invitation, join request, an admin adding
-- them) ends in one of these inserts.
CREATE OR REPLACE FUNCTION public.refuse_blocked_workspace_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspace_blocked_users b WHERE b.workspace_id = NEW.workspace_id AND b.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'You can''t join this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_members_refuse_blocked ON public.workspace_members;
CREATE TRIGGER trg_workspace_members_refuse_blocked BEFORE INSERT ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.refuse_blocked_workspace_user();
DROP TRIGGER IF EXISTS trg_workspace_join_requests_refuse_blocked ON public.workspace_join_requests;
CREATE TRIGGER trg_workspace_join_requests_refuse_blocked BEFORE INSERT ON public.workspace_join_requests
  FOR EACH ROW EXECUTE FUNCTION public.refuse_blocked_workspace_user();

-- Same permission rules as remove_workspace_member; also blocks rejoining and
-- cancels their pending invitations and join requests.
CREATE OR REPLACE FUNCTION public.remove_and_block_member(p_workspace_id uuid, p_target_user_id uuid)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  actor uuid := auth.uid();
  caller_role text := public.user_role_in_workspace(p_workspace_id, auth.uid());
  target_role text := public.user_role_in_workspace(p_workspace_id, p_target_user_id);
  target_email text;
BEGIN
  IF actor IS NULL OR caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RETURN json_build_object('allowed', false, 'reason', 'Only workspace owners and admins can block members.');
  END IF;
  IF p_target_user_id = actor THEN
    RETURN json_build_object('allowed', false, 'reason', 'You can''t block yourself.');
  END IF;
  IF target_role = 'owner' THEN
    RETURN json_build_object('allowed', false, 'reason', 'The owner can''t be blocked.');
  END IF;
  IF target_role = 'admin' AND caller_role <> 'owner' THEN
    RETURN json_build_object('allowed', false, 'reason', 'Only the owner can block an admin.');
  END IF;

  INSERT INTO public.workspace_blocked_users (workspace_id, user_id, blocked_by)
  VALUES (p_workspace_id, p_target_user_id, actor)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;
  DELETE FROM public.workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;

  SELECT email INTO target_email FROM auth.users WHERE id = p_target_user_id;
  UPDATE public.invitations SET status = 'cancelled', updated_at = now()
  WHERE workspace_id = p_workspace_id AND status = 'pending'
    AND (user_id = p_target_user_id OR (target_email IS NOT NULL AND lower(email) = lower(target_email)));
  UPDATE public.workspace_join_requests SET status = 'rejected', decided_by = actor, decided_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id AND status = 'pending';
  RETURN json_build_object('allowed', true);
END $$;

CREATE OR REPLACE FUNCTION public.unblock_workspace_user(p_workspace_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace owners and admins can unblock people' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.workspace_blocked_users WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
END $$;

-- Blocked people with names, for the members page.
CREATE OR REPLACE FUNCTION public.list_blocked_workspace_users(p_workspace_id uuid)
RETURNS TABLE (user_id uuid, display_name text, email text, blocked_at timestamptz, blocked_by_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT b.user_id,
         coalesce(p.display_name, p.username),
         u.email::text,
         b.created_at,
         coalesce(bp.display_name, bp.username)
  FROM public.workspace_blocked_users b
  LEFT JOIN public.profiles p ON p.id = b.user_id
  LEFT JOIN auth.users u ON u.id = b.user_id
  LEFT JOIN public.profiles bp ON bp.id = b.blocked_by
  WHERE b.workspace_id = p_workspace_id
    AND public.user_is_workspace_admin(p_workspace_id, auth.uid())
  ORDER BY b.created_at DESC;
$$;

-- ── GitHub project agent ───────────────────────────────────────────────────

-- The read-only token, sealed by the server (AES-GCM); never readable by clients.
CREATE TABLE IF NOT EXISTS public.workspace_github_connections (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  login text NOT NULL,
  token_sealed jsonb NOT NULL,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.workspace_github_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_github_connections FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.project_github_links (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  repo_full_name text NOT NULL CHECK (repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  default_branch text NOT NULL DEFAULT 'main',
  html_url text,
  -- Runs on its behalf: notes, notifications and proposals name this member.
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  review_weekday smallint NOT NULL DEFAULT 4 CHECK (review_weekday BETWEEN 0 AND 6), -- 4 = Thursday
  review_time time NOT NULL DEFAULT '09:00',
  timezone text NOT NULL DEFAULT 'Europe/Bucharest',
  last_review_on date,
  last_reviewed_at timestamptz,
  last_review jsonb
);
ALTER TABLE public.project_github_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_github_links_read ON public.project_github_links;
CREATE POLICY project_github_links_read ON public.project_github_links FOR SELECT TO authenticated
  USING (public.user_is_workspace_member(workspace_id, auth.uid())
         AND EXISTS (SELECT 1 FROM public.projects project WHERE project.id = project_github_links.project_id));
REVOKE INSERT, UPDATE, DELETE ON public.project_github_links FROM anon, authenticated;
GRANT SELECT ON public.project_github_links TO authenticated;

-- Imported issues, so a re-import never duplicates a task.
CREATE TABLE IF NOT EXISTS public.task_github_issues (
  task_id uuid PRIMARY KEY REFERENCES public.tasks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  issue_number integer NOT NULL,
  issue_url text NOT NULL,
  UNIQUE (project_id, issue_number)
);
ALTER TABLE public.task_github_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_github_issues_read ON public.task_github_issues;
CREATE POLICY task_github_issues_read ON public.task_github_issues FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tasks task WHERE task.id = task_github_issues.task_id));
REVOKE INSERT, UPDATE, DELETE ON public.task_github_issues FROM anon, authenticated;
GRANT SELECT ON public.task_github_issues TO authenticated;

-- A status change the agent suggests from commits; a project manager decides.
CREATE TABLE IF NOT EXISTS public.task_status_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('todo', 'in_progress', 'done')),
  note text NOT NULL CHECK (length(note) <= 4000),
  commits jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_status_proposals_pending ON public.task_status_proposals (task_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_task_status_proposals_workspace ON public.task_status_proposals (workspace_id, created_at DESC);
ALTER TABLE public.task_status_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_status_proposals_read ON public.task_status_proposals;
CREATE POLICY task_status_proposals_read ON public.task_status_proposals FOR SELECT TO authenticated
  USING (public.user_is_workspace_member(workspace_id, auth.uid())
         AND (public.is_task_approver(workspace_id, auth.uid())
              OR EXISTS (SELECT 1 FROM public.task_assignees a WHERE a.task_id = task_status_proposals.task_id AND a.user_id = auth.uid())));
REVOKE INSERT, UPDATE, DELETE ON public.task_status_proposals FROM anon, authenticated;
GRANT SELECT ON public.task_status_proposals TO authenticated;

-- Creates the project for a repository on behalf of p_actor (server only).
CREATE OR REPLACE FUNCTION public.github_create_project(
  p_actor uuid, p_workspace_id uuid, p_repo text, p_description text, p_branch text, p_url text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  project uuid;
BEGIN
  IF NOT public.user_is_workspace_member(p_workspace_id, p_actor) THEN
    RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '42501';
  END IF;
  SELECT link.project_id INTO project
  FROM public.project_github_links link
  JOIN public.projects p ON p.id = link.project_id AND p.deleted_at IS NULL
  WHERE link.workspace_id = p_workspace_id AND lower(link.repo_full_name) = lower(p_repo);
  IF project IS NOT NULL THEN RETURN project; END IF;

  INSERT INTO public.projects (workspace_id, name, description, icon, color, owner_id)
  VALUES (p_workspace_id, split_part(p_repo, '/', 2), left(coalesce(p_description, 'GitHub: ' || p_repo), 2000), '🐙', '#24292f', p_actor)
  RETURNING id INTO project;
  INSERT INTO public.project_members (project_id, user_id, role) VALUES (project, p_actor, 'owner');
  INSERT INTO public.project_columns (project_id, name, sort_order, position)
  VALUES (project, 'Backlog', 0, 0), (project, 'To Do', 1, 1), (project, 'In Progress', 2, 2), (project, 'Done', 3, 3);
  INSERT INTO public.project_github_links (project_id, workspace_id, repo_full_name, default_branch, html_url, created_by)
  VALUES (project, p_workspace_id, p_repo, coalesce(nullif(p_branch, ''), 'main'), p_url, p_actor);
  RETURN project;
END $$;

-- The board column for a status, by the default column names.
CREATE OR REPLACE FUNCTION public.github_column_for(p_project_id uuid, p_status text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT c.id FROM public.project_columns c
  WHERE c.project_id = p_project_id
    AND lower(c.name) = CASE p_status WHEN 'done' THEN 'done' WHEN 'in_progress' THEN 'in progress' ELSE 'to do' END
  ORDER BY c.position LIMIT 1;
$$;

-- Imports open issues as tasks; existing ones are skipped (server only).
CREATE OR REPLACE FUNCTION public.github_import_issues(p_actor uuid, p_project_id uuid, p_issues jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  link public.project_github_links%ROWTYPE;
  issue jsonb;
  task uuid;
  added integer := 0;
BEGIN
  SELECT * INTO link FROM public.project_github_links WHERE project_id = p_project_id;
  IF link.project_id IS NULL OR NOT public.user_is_workspace_member(link.workspace_id, p_actor) THEN
    RAISE EXCEPTION 'Project not linked' USING ERRCODE = '42501';
  END IF;
  FOR issue IN SELECT * FROM jsonb_array_elements(coalesce(p_issues, '[]'::jsonb)) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.task_github_issues t WHERE t.project_id = p_project_id AND t.issue_number = (issue ->> 'number')::integer);
    INSERT INTO public.tasks (workspace_id, project_id, column_id, title, description, status, priority, created_by)
    VALUES (
      link.workspace_id, p_project_id, public.github_column_for(p_project_id, 'todo'),
      left(issue ->> 'title', 300),
      left(coalesce(issue ->> 'body', '') || E'\n\nGitHub issue: ' || (issue ->> 'url'), 8000),
      'todo', 'medium', p_actor
    ) RETURNING id INTO task;
    INSERT INTO public.task_github_issues (task_id, project_id, issue_number, issue_url)
    VALUES (task, p_project_id, (issue ->> 'number')::integer, issue ->> 'url');
    INSERT INTO public.task_activity (task_id, user_id, action, description)
    VALUES (task, p_actor, 'created', 'Imported from GitHub issue #' || (issue ->> 'number'));
    added := added + 1;
  END LOOP;
  RETURN added;
END $$;

-- AI-suggested starting tasks go to Tasks → Approvals (server only).
CREATE OR REPLACE FUNCTION public.github_suggest_tasks(p_actor uuid, p_project_id uuid, p_tasks jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  link public.project_github_links%ROWTYPE;
  item jsonb;
  added integer := 0;
BEGIN
  SELECT * INTO link FROM public.project_github_links WHERE project_id = p_project_id;
  IF link.project_id IS NULL OR NOT public.user_is_workspace_member(link.workspace_id, p_actor) THEN
    RAISE EXCEPTION 'Project not linked' USING ERRCODE = '42501';
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) LIMIT 15 LOOP
    CONTINUE WHEN coalesce(btrim(item ->> 'title'), '') = '';
    INSERT INTO public.task_requests (workspace_id, title, description, priority, project_id, source_label, submitted_by, idempotency_key)
    VALUES (
      link.workspace_id, left(btrim(item ->> 'title'), 300), left(item ->> 'description', 8000),
      CASE WHEN item ->> 'priority' IN ('low', 'medium', 'high', 'urgent') THEN item ->> 'priority' ELSE 'medium' END,
      p_project_id, left('GitHub · ' || link.repo_full_name, 200), p_actor,
      'github:' || p_project_id::text || ':' || md5(lower(btrim(item ->> 'title')))
    ) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;
    IF FOUND THEN added := added + 1; END IF;
  END LOOP;
  RETURN added;
END $$;

-- Claims projects whose weekly review time has come (worker only).
CREATE OR REPLACE FUNCTION public.github_claim_due_reviews()
RETURNS TABLE (project_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  UPDATE public.project_github_links link
  SET last_review_on = (now() AT TIME ZONE link.timezone)::date
  WHERE extract(dow FROM now() AT TIME ZONE link.timezone) = link.review_weekday
    AND (now() AT TIME ZONE link.timezone)::time >= link.review_time
    AND (link.last_review_on IS NULL OR link.last_review_on < (now() AT TIME ZONE link.timezone)::date)
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = link.project_id AND p.deleted_at IS NULL AND p.archived_at IS NULL)
  RETURNING link.project_id;
$$;

-- Applies one review: a progress note on each matched task, an inbox message
-- for its assignees, and a pending status proposal when the status should
-- change (server only). p_items: [{task_id, note, commits:[{sha,url,message}], suggested_status}]
CREATE OR REPLACE FUNCTION public.github_apply_review(p_project_id uuid, p_items jsonb, p_summary jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  link public.project_github_links%ROWTYPE;
  item jsonb;
  task public.tasks%ROWTYPE;
  notes integer := 0;
  proposals integer := 0;
  next_status text;
BEGIN
  SELECT * INTO link FROM public.project_github_links WHERE project_id = p_project_id FOR UPDATE;
  IF link.project_id IS NULL THEN RAISE EXCEPTION 'Project not linked' USING ERRCODE = '22023'; END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    SELECT * INTO task FROM public.tasks
    WHERE id = (item ->> 'task_id')::uuid AND project_id = p_project_id AND archived_at IS NULL AND deleted_at IS NULL;
    CONTINUE WHEN task.id IS NULL OR coalesce(btrim(item ->> 'note'), '') = '';

    INSERT INTO public.task_activity (task_id, user_id, action, description, details)
    VALUES (task.id, NULL, 'agent_progress', left('Project agent: ' || btrim(item ->> 'note'), 2000),
            jsonb_build_object('commits', coalesce(item -> 'commits', '[]'::jsonb), 'repo', link.repo_full_name));
    notes := notes + 1;

    next_status := item ->> 'suggested_status';
    IF next_status IN ('in_progress', 'done') AND next_status IS DISTINCT FROM task.status
       AND NOT EXISTS (SELECT 1 FROM public.task_status_proposals p WHERE p.task_id = task.id AND p.status = 'pending') THEN
      INSERT INTO public.task_status_proposals (workspace_id, task_id, project_id, from_status, to_status, note, commits, requested_by)
      VALUES (task.workspace_id, task.id, p_project_id, task.status, next_status, left(btrim(item ->> 'note'), 4000),
              coalesce(item -> 'commits', '[]'::jsonb), link.created_by);
      proposals := proposals + 1;
    END IF;

    INSERT INTO public.notifications (user_id, workspace_id, type, category, title, message, link, entity_type, entity_id)
    SELECT a.user_id, task.workspace_id, 'task_progress', 'tasks',
           'Progress on “' || left(task.title, 80) || '”',
           left(btrim(item ->> 'note'), 400)
             || CASE WHEN next_status IN ('in_progress', 'done') AND next_status IS DISTINCT FROM task.status
                     THEN ' · Suggested status: ' || replace(next_status, '_', ' ') ELSE '' END,
           '/tasks/' || task.id, 'task', task.id
    FROM public.task_assignees a WHERE a.task_id = task.id;
  END LOOP;

  UPDATE public.project_github_links
  SET last_reviewed_at = now(),
      last_review = coalesce(p_summary, '{}'::jsonb) || jsonb_build_object('notes', notes, 'proposals', proposals)
  WHERE project_id = p_project_id;
  RETURN jsonb_build_object('notes', notes, 'proposals', proposals);
END $$;

-- A project manager approves or declines a suggested status change.
CREATE OR REPLACE FUNCTION public.decide_task_status_proposal(p_proposal_id uuid, p_approve boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  proposal public.task_status_proposals%ROWTYPE;
  target_column uuid;
BEGIN
  SELECT * INTO proposal FROM public.task_status_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF proposal.id IS NULL OR NOT public.is_task_approver(proposal.workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only project managers can decide status changes' USING ERRCODE = '42501';
  END IF;
  IF proposal.status <> 'pending' THEN
    RETURN jsonb_build_object('status', proposal.status);
  END IF;
  UPDATE public.task_status_proposals
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_by = auth.uid(), decided_at = now()
  WHERE id = proposal.id;
  IF p_approve THEN
    target_column := public.github_column_for(proposal.project_id, proposal.to_status);
    UPDATE public.tasks
    SET status = proposal.to_status,
        column_id = coalesce(target_column, tasks.column_id),
        updated_at = now()
    WHERE id = proposal.task_id;
    INSERT INTO public.task_activity (task_id, user_id, action, old_value, new_value, description)
    VALUES (proposal.task_id, auth.uid(), 'status_changed', proposal.from_status, proposal.to_status,
            'Approved the project agent''s suggestion');
  END IF;
  RETURN jsonb_build_object('status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END $$;

REVOKE ALL ON FUNCTION public.refuse_blocked_workspace_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_and_block_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unblock_workspace_user(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_blocked_workspace_users(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_task_status_proposal(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_and_block_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unblock_workspace_user(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_blocked_workspace_users(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_task_status_proposal(uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.github_create_project(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.github_column_for(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.github_import_issues(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.github_suggest_tasks(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.github_claim_due_reviews() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.github_apply_review(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.github_create_project(uuid, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.github_column_for(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.github_import_issues(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.github_suggest_tasks(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.github_claim_due_reviews() TO service_role;
GRANT EXECUTE ON FUNCTION public.github_apply_review(uuid, jsonb, jsonb) TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_github_connections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_github_links TO service_role;
GRANT SELECT ON public.tasks, public.task_assignees, public.projects TO service_role;

NOTIFY pgrst, 'reload schema';
