-- Serialize every agent-created business mutation and approval with Stop.
-- This migration is additive because 00400 and 00500 may already be applied.

-- Cancellation also settles manager-reviewed task requests. Wrap the existing
-- functions rather than copying their accounting and team-settlement logic.
DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_finish_run_pre_task_request_cancellation(uuid,text,text,text,jsonb,text,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_finish_run(uuid, text, text, text, jsonb, text, text)
      RENAME TO agent_finish_run_pre_task_request_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_finish_run(
  p_run_id uuid, p_worker text, p_status text, p_content text,
  p_usage jsonb, p_error_code text, p_error_message text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_final text;
BEGIN
  v_final := public.agent_finish_run_pre_task_request_cancellation(
    p_run_id, p_worker, p_status, p_content,
    p_usage, p_error_code, p_error_message
  );
  IF v_final = 'cancelled' THEN
    UPDATE public.task_requests
    SET status = 'rejected',
        decided_at = coalesce(decided_at, now()),
        decision_note = coalesce(decision_note, 'Agent run cancelled'),
        updated_at = now()
    WHERE agent_run_id = p_run_id AND status = 'pending';
  END IF;
  RETURN v_final;
END $$;

DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_terminalize_team_task_pre_task_request_cancellation(uuid,text,text,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_terminalize_team_task(uuid, text, text, text)
      RENAME TO agent_terminalize_team_task_pre_task_request_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_terminalize_team_task(
  p_task_id uuid, p_status text, p_error_code text, p_error_message text
) RETURNS public.agent_team_tasks
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_task public.agent_team_tasks%ROWTYPE;
BEGIN
  v_task := public.agent_terminalize_team_task_pre_task_request_cancellation(
    p_task_id, p_status, p_error_code, p_error_message
  );
  IF v_task.child_run_id IS NOT NULL
     AND v_task.status IN ('cancelled', 'interrupted') THEN
    UPDATE public.task_requests
    SET status = 'rejected',
        decided_at = coalesce(decided_at, now()),
        decision_note = coalesce(decision_note, 'Agent run cancelled'),
        updated_at = now()
    WHERE agent_run_id = v_task.child_run_id AND status = 'pending';
  END IF;
  RETURN v_task;
END $$;

DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_cancel_run_pre_task_request_cancellation(uuid)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_cancel_run(uuid)
      RENAME TO agent_cancel_run_pre_task_request_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_cancel_run(p_run_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_result text;
BEGIN
  v_result := public.agent_cancel_run_pre_task_request_cancellation(p_run_id);
  IF v_result IN ('cancelling', 'cancelled') THEN
    UPDATE public.task_requests
    SET status = 'rejected',
        decided_at = coalesce(decided_at, now()),
        decision_note = coalesce(decision_note, 'Agent run cancelled'),
        updated_at = now()
    WHERE status = 'pending'
      AND agent_run_id IN (
        SELECT p_run_id
        UNION
        SELECT id FROM public.agent_runs WHERE parent_run_id = p_run_id
      );
  END IF;
  RETURN v_result;
END $$;

-- Tool-side writes all take the run row first and hold it through the previous
-- implementation. Stop and a mutation therefore have an unambiguous winner.
DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_create_proposal_pre_cancellation(uuid,text,text,jsonb,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_create_proposal(uuid, text, text, jsonb, text)
      RENAME TO agent_create_proposal_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_create_proposal(
  p_run_id uuid, p_tool_use_id text, p_action_type text,
  p_arguments jsonb, p_summary text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF v_run.id IS NULL OR v_run.status <> 'running'
     OR v_run.cancel_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;
  RETURN public.agent_create_proposal_pre_cancellation(
    p_run_id, p_tool_use_id, p_action_type, p_arguments, p_summary
  );
END $$;

DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_submit_task_requests_pre_cancellation(uuid,text,jsonb,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
      RENAME TO agent_submit_task_requests_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_submit_task_requests(
  p_run_id uuid, p_tool_use_id text, p_tasks jsonb, p_source_label text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF v_run.id IS NULL OR v_run.status <> 'running'
     OR v_run.cancel_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;
  RETURN public.agent_submit_task_requests_pre_cancellation(
    p_run_id, p_tool_use_id, p_tasks, p_source_label
  );
END $$;

DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_save_personal_note_pre_cancellation(uuid,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_save_personal_note(uuid, text)
      RENAME TO agent_save_personal_note_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_save_personal_note(
  p_run_id uuid, p_content text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF v_run.id IS NULL OR v_run.status <> 'running'
     OR v_run.cancel_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;
  RETURN public.agent_save_personal_note_pre_cancellation(p_run_id, p_content);
END $$;

-- Execution is internal to the authenticated decision/reply functions. Lock
-- run then proposal, and require the proposal's one-time executing state.
DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_execute_proposal_pre_cancellation(uuid)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_execute_proposal(uuid)
      RENAME TO agent_execute_proposal_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_execute_proposal(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run_id uuid;
  v_run public.agent_runs%ROWTYPE;
  v_status text;
BEGIN
  SELECT run_id INTO v_run_id
  FROM public.agent_action_proposals
  WHERE id = p_id;
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'Proposal not found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = v_run_id
  FOR UPDATE;
  SELECT status INTO v_status
  FROM public.agent_action_proposals
  WHERE id = p_id
  FOR UPDATE;
  IF v_run.id IS NULL
     OR v_run.cancel_requested_at IS NOT NULL
     OR v_run.status NOT IN ('running', 'awaiting_approval', 'completed')
     OR v_status <> 'executing' THEN
    RAISE EXCEPTION 'Proposal is not executable' USING ERRCODE = '55000';
  END IF;
  RETURN public.agent_execute_proposal_pre_cancellation(p_id);
END $$;

-- Authenticated approval/revision functions must also enter via run -> proposal
-- order. Scope the initial lookup to the requester before taking a run lock.
DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_decide_proposal_pre_cancellation(uuid,boolean,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_decide_proposal(uuid, boolean, text)
      RENAME TO agent_decide_proposal_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_decide_proposal(
  p_proposal_id uuid, p_approve boolean, p_arguments_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run_id uuid;
  v_run public.agent_runs%ROWTYPE;
BEGIN
  SELECT run_id INTO v_run_id
  FROM public.agent_action_proposals
  WHERE id = p_proposal_id AND requested_for = auth.uid();
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'Proposal not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = v_run_id
  FOR UPDATE;
  IF v_run.id IS NULL
     OR v_run.cancel_requested_at IS NOT NULL
     OR v_run.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'cancelled');
  END IF;
  RETURN public.agent_decide_proposal_pre_cancellation(
    p_proposal_id, p_approve, p_arguments_hash
  );
END $$;

DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_revise_proposal_pre_cancellation(uuid,jsonb)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_revise_proposal(uuid, jsonb)
      RENAME TO agent_revise_proposal_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_revise_proposal(
  p_proposal_id uuid, p_arguments jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run_id uuid;
  v_run public.agent_runs%ROWTYPE;
BEGIN
  SELECT run_id INTO v_run_id
  FROM public.agent_action_proposals
  WHERE id = p_proposal_id AND requested_for = auth.uid();
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'Proposal not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = v_run_id
  FOR UPDATE;
  IF v_run.id IS NULL
     OR v_run.cancel_requested_at IS NOT NULL
     OR v_run.status = 'cancelled' THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;
  RETURN public.agent_revise_proposal_pre_cancellation(
    p_proposal_id, p_arguments
  );
END $$;

-- Task approval has its own table but follows the same run -> request order.
DO $$ BEGIN
  IF to_regprocedure(
    'public.decide_task_request_pre_cancellation(uuid,boolean,jsonb,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.decide_task_request(uuid, boolean, jsonb, text)
      RENAME TO decide_task_request_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.decide_task_request(
  p_request_id uuid, p_approve boolean,
  p_changes jsonb DEFAULT '{}'::jsonb, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run_id uuid;
  v_workspace_id uuid;
  v_run public.agent_runs%ROWTYPE;
BEGIN
  SELECT request.agent_run_id, request.workspace_id
  INTO v_run_id, v_workspace_id
  FROM public.task_requests request
  WHERE request.id = p_request_id
    AND public.user_is_workspace_member(request.workspace_id, auth.uid())
    AND public.is_task_approver(request.workspace_id, auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task request not found' USING ERRCODE = '42501';
  END IF;
  IF v_run_id IS NOT NULL THEN
    SELECT * INTO v_run
    FROM public.agent_runs
    WHERE id = v_run_id
    FOR UPDATE;
    IF v_run.id IS NULL
       OR v_run.cancel_requested_at IS NOT NULL
       OR v_run.status = 'cancelled' THEN
      UPDATE public.task_requests
      SET status = 'rejected',
          decided_at = coalesce(decided_at, now()),
          decision_note = coalesce(decision_note, 'Agent run cancelled'),
          updated_at = now()
      WHERE id = p_request_id AND status = 'pending';
      RETURN jsonb_build_object('status', 'rejected');
    END IF;
  END IF;
  RETURN public.decide_task_request_pre_cancellation(
    p_request_id, p_approve, p_changes, p_note
  );
END $$;

-- Sharing a finished answer creates a new reviewed proposal, so awaiting-run
-- cancellation must serialize with it too.
DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_share_output_pre_cancellation(uuid,uuid,uuid)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_share_output(uuid, uuid, uuid)
      RENAME TO agent_share_output_pre_cancellation;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_share_output(
  p_run_id uuid, p_channel_id uuid, p_parent_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id AND requested_by = auth.uid()
  FOR UPDATE;
  IF v_run.id IS NULL
     OR v_run.cancel_requested_at IS NOT NULL
     OR v_run.status NOT IN ('completed', 'awaiting_approval') THEN
    RAISE EXCEPTION 'Answer not found' USING ERRCODE = '42501';
  END IF;
  RETURN public.agent_share_output_pre_cancellation(
    p_run_id, p_channel_id, p_parent_id
  );
END $$;

-- Only the guarded entry points are callable. The renamed implementations and
-- older executor chain remain available to their SECURITY DEFINER owners, not
-- as service-role bypasses.
REVOKE ALL ON FUNCTION public.agent_finish_run_pre_task_request_cancellation(
  uuid, text, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_terminalize_team_task_pre_task_request_cancellation(
  uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_cancel_run_pre_task_request_cancellation(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_create_proposal_pre_cancellation(
  uuid, text, text, jsonb, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_submit_task_requests_pre_cancellation(
  uuid, text, jsonb, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_save_personal_note_pre_cancellation(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_execute_proposal_pre_cancellation(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_decide_proposal_pre_cancellation(uuid, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_revise_proposal_pre_cancellation(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.decide_task_request_pre_cancellation(
  uuid, boolean, jsonb, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_share_output_pre_cancellation(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_execute_proposal_core(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_execute_proposal_pre_drive(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_execute_proposal_pre_social(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_execute_proposal_pre_company(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.decide_task_request_pre_company(
  uuid, boolean, jsonb, text
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.agent_finish_run(
  uuid, text, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_terminalize_team_task(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_create_proposal(uuid, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_save_personal_note(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_execute_proposal(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_finish_run(
  uuid, text, text, text, jsonb, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_terminalize_team_task(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_create_proposal(uuid, text, text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_save_personal_note(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.agent_cancel_run(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agent_decide_proposal(uuid, boolean, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agent_revise_proposal(uuid, jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_task_request(uuid, boolean, jsonb, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agent_share_output(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_cancel_run(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_decide_proposal(uuid, boolean, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_revise_proposal(uuid, jsonb)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_task_request(uuid, boolean, jsonb, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_share_output(uuid, uuid, uuid)
  TO authenticated, service_role;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
