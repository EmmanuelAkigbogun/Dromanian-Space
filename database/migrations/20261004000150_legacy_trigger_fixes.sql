-- ============================================================================
-- 20261004000150_legacy_trigger_fixes.sql
-- ----------------------------------------------------------------------------
-- fn_automation_task_assigned (legacy 050) selected into fields of an
-- unassigned RECORD ("record v_task is not assigned yet"), so every
-- task_assignees insert at trigger depth 1 raised and the assignment failed.
-- Same behaviour, with a proper row variable. Automation failures must never
-- block the user's write, so the evaluation is also isolated.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_automation_task_assigned()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_task tasks%ROWTYPE;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  SELECT * INTO v_task FROM tasks WHERE id = NEW.task_id;
  IF v_task.id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    PERFORM public.evaluate_automation_rules(
      v_task.workspace_id, 'task.assigned', NEW.task_id,
      jsonb_build_object(
        'entity_id', NEW.task_id,
        'entity_type', 'task',
        'assignee_id', NEW.user_id,
        'title', coalesce(v_task.title, ''),
        'status', coalesce(v_task.status, ''),
        'priority', coalesce(v_task.priority, ''),
        'project_id', coalesce(v_task.project_id::text, ''),
        'created_by', v_task.created_by,
        'user_id', v_task.created_by,
        'due_date', coalesce(v_task.due_date::text, ''),
        'is_overdue', CASE WHEN v_task.due_date IS NOT NULL AND v_task.due_date < now() THEN 'true' ELSE 'false' END,
        'has_due_date', CASE WHEN v_task.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
        'link', '/tasks'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'task.assigned automation failed task=% err=%', NEW.task_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
