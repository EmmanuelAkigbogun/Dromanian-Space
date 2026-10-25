-- ============================================================================
-- 20261025000100_dashboard_insights.sql
-- ----------------------------------------------------------------------------
-- Data for the redesigned Home dashboard: weekly task throughput, active
-- project progress and the viewer's recent activity. SECURITY INVOKER, so
-- row-level security limits every number to what the viewer can see.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.workspace_dashboard_insights(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $$
WITH weeks AS (
  SELECT generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS week_start
),
visible_tasks AS (
  SELECT t.id, t.created_at, t.status, t.updated_at
  FROM tasks t
  WHERE t.workspace_id = p_workspace_id AND t.deleted_at IS NULL
),
completions AS (
  -- Status changes were recorded in two shapes over time; fall back to the
  -- task's last update when no change to "completed" was recorded.
  SELECT vt.id,
    coalesce((SELECT min(a.created_at) FROM task_activity a
              WHERE a.task_id = vt.id AND a.action = 'status_changed'
                AND coalesce(a.details ->> 'status', a.new_value) = 'completed'), vt.updated_at) AS completed_at
  FROM visible_tasks vt
  WHERE vt.status = 'completed'
),
throughput AS (
  SELECT w.week_start,
    (SELECT count(*) FROM visible_tasks vt WHERE vt.created_at >= w.week_start AND vt.created_at < w.week_start + interval '1 week') AS opened,
    (SELECT count(*) FROM completions c WHERE c.completed_at >= w.week_start AND c.completed_at < w.week_start + interval '1 week') AS completed
  FROM weeks w
),
active_projects AS (
  SELECT p.id, p.name, p.color, p.due_date, p.updated_at,
    (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status <> 'cancelled') AS total,
    (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'completed') AS done,
    ARRAY(SELECT pm.user_id FROM project_members pm WHERE pm.project_id = p.id ORDER BY pm.created_at LIMIT 4) AS member_ids
  FROM projects p
  WHERE p.workspace_id = p_workspace_id AND p.status = 'active' AND p.archived_at IS NULL AND p.deleted_at IS NULL
  ORDER BY p.updated_at DESC
  LIMIT 4
)
SELECT jsonb_build_object(
  'throughput', coalesce((SELECT jsonb_agg(jsonb_build_object('week_start', week_start, 'opened', opened, 'completed', completed) ORDER BY week_start) FROM throughput), '[]'::jsonb),
  'completed_tasks', (SELECT count(*) FROM visible_tasks WHERE status = 'completed'),
  'open_tasks', (SELECT count(*) FROM visible_tasks WHERE status NOT IN ('completed', 'cancelled')),
  'projects', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'color', color, 'due_date', due_date,
                        'total', total, 'done', done, 'member_ids', to_jsonb(member_ids)) ORDER BY updated_at DESC) FROM active_projects), '[]'::jsonb),
  'activity', coalesce((SELECT jsonb_agg(x ORDER BY x.created_at DESC) FROM (
      SELECT n.id, n.title, n.message, n.link, n.actor_id, n.created_at, n.read
      FROM notifications n
      WHERE n.user_id = auth.uid() AND (n.workspace_id = p_workspace_id OR n.workspace_id IS NULL)
      ORDER BY n.created_at DESC
      LIMIT 6) x), '[]'::jsonb)
)
WHERE user_is_workspace_member(p_workspace_id, auth.uid());
$$;

REVOKE ALL ON FUNCTION public.workspace_dashboard_insights(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_dashboard_insights(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
