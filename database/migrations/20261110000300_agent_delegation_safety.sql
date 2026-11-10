-- Coordinator delegation must be idempotent within one payload as well as
-- across retries. A duplicate task used to return the same child twice even
-- though the unique constraints correctly persisted it only once.
CREATE OR REPLACE FUNCTION public.agent_delegate(
  p_parent_run_id uuid, p_tasks jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  parent public.agent_runs%ROWTYPE;
  task jsonb;
  agent public.workspace_agents%ROWTYPE;
  version public.workspace_agent_versions%ROWTYPE;
  existing public.agent_team_tasks%ROWTYPE;
  task_instruction text;
  template_kind text;
  identity text;
  seen_identities text[] := '{}';
  normalized jsonb := '[]'::jsonb;
  delegation_key text;
  task_count integer;
  ordinal integer;
  child_run_id uuid;
  input_message_id uuid;
  output_message_id uuid;
  returned_child_ids uuid[] := '{}';
  output jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO parent
  FROM public.agent_runs
  WHERE id = p_parent_run_id
  FOR UPDATE;
  IF parent.id IS NULL OR parent.status <> 'running' THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;
  IF parent.depth > 0 THEN
    RAISE EXCEPTION 'Specialists cannot delegate further' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_tasks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Delegate between 1 and 4 tasks at a time'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_tasks) NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'Delegate between 1 and 4 tasks at a time'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve the agent before deduplication. UUID spelling and redundant outer
  -- whitespace therefore cannot create two logical copies of the same task.
  FOR task IN SELECT value FROM jsonb_array_elements(p_tasks) LOOP
    task_instruction := btrim(coalesce(task ->> 'instruction', ''));
    IF length(task_instruction) = 0 OR length(task_instruction) > 4000 THEN
      RAISE EXCEPTION 'Each task needs an instruction of up to 4000 characters'
        USING ERRCODE = '22023';
    END IF;
    SELECT candidate.* INTO agent
    FROM public.workspace_agents candidate
    WHERE candidate.id = nullif(task ->> 'agent_id', '')::uuid
      AND candidate.workspace_id = parent.workspace_id;
    SELECT template.kind INTO template_kind
    FROM public.agent_templates template
    WHERE template.key = agent.template_key;
    IF agent.id IS NULL OR agent.status <> 'active'
       OR agent.archived_at IS NOT NULL
       OR NOT public.agent_visible_to(agent.id, parent.requested_by)
       OR coalesce(template_kind, 'specialist') <> 'specialist' THEN
      RAISE EXCEPTION 'A requested specialist is not available'
        USING ERRCODE = '42501';
    END IF;
    identity := agent.id::text || ':' || task_instruction;
    IF NOT identity = ANY(seen_identities) THEN
      seen_identities := array_append(seen_identities, identity);
      normalized := normalized || jsonb_build_object(
        'agent_id', agent.id,
        'instruction', task_instruction
      );
    END IF;
  END LOOP;

  SELECT count(*) INTO task_count
  FROM public.agent_team_tasks team_task
  WHERE team_task.parent_run_id = p_parent_run_id;

  FOR task IN SELECT value FROM jsonb_array_elements(normalized) LOOP
    task_instruction := task ->> 'instruction';
    SELECT candidate.* INTO agent
    FROM public.workspace_agents candidate
    WHERE candidate.id = (task ->> 'agent_id')::uuid
      AND candidate.workspace_id = parent.workspace_id;
    SELECT candidate.* INTO version
    FROM public.workspace_agent_versions candidate
    WHERE candidate.id = agent.current_version_id;
    delegation_key := encode(extensions.digest(
      convert_to(agent.id::text || ':' || task_instruction, 'UTF8'), 'sha256'
    ), 'hex');

    -- Match the logical identity first so a legacy, non-canonical hash cannot
    -- cause a duplicate child on a later retry.
    existing := NULL;
    SELECT team_task.* INTO existing
    FROM public.agent_team_tasks team_task
    WHERE team_task.parent_run_id = p_parent_run_id
      AND team_task.agent_id = agent.id
      AND team_task.instruction = task_instruction
    ORDER BY team_task.created_at, team_task.id
    LIMIT 1;
    IF existing.id IS NOT NULL THEN
      IF NOT existing.child_run_id = ANY(returned_child_ids) THEN
        returned_child_ids := array_append(
          returned_child_ids, existing.child_run_id
        );
        output := output || jsonb_build_object(
          'task_id', existing.id,
          'child_run_id', existing.child_run_id,
          'agent_id', existing.agent_id,
          'reused', true
        );
      END IF;
      CONTINUE;
    END IF;

    SELECT team_task.* INTO existing
    FROM public.agent_team_tasks team_task
    WHERE team_task.parent_run_id = p_parent_run_id
      AND team_task.idempotency_key = delegation_key;
    IF existing.id IS NOT NULL THEN
      RAISE EXCEPTION 'Delegation identity conflict'
        USING ERRCODE = '23505';
    END IF;
    IF task_count >= 8 THEN
      RAISE EXCEPTION 'This team run has reached its delegation budget (8 tasks)'
        USING ERRCODE = '53400';
    END IF;
    IF version.id IS NULL THEN
      RAISE EXCEPTION 'A requested specialist is not available'
        USING ERRCODE = '42501';
    END IF;

    ordinal := task_count + 1;
    child_run_id := gen_random_uuid();
    INSERT INTO public.agent_messages (
      conversation_id, workspace_id, role, content, status, run_id,
      scope, created_by, kind
    ) VALUES (
      parent.conversation_id, parent.workspace_id, 'user', task_instruction,
      'complete', child_run_id, parent.scope, parent.requested_by, 'delegation'
    ) RETURNING id INTO input_message_id;
    INSERT INTO public.agent_messages (
      conversation_id, workspace_id, role, content, status, run_id,
      created_by, kind
    ) VALUES (
      parent.conversation_id, parent.workspace_id, 'assistant', '',
      'streaming', child_run_id, NULL, 'delegation'
    ) RETURNING id INTO output_message_id;
    INSERT INTO public.agent_runs (
      id, workspace_id, conversation_id, agent_id, agent_version_id,
      requested_by, input_message_id, output_message_id, trigger,
      destination, scope, model, effort, idempotency_key,
      parent_run_id, depth
    ) VALUES (
      child_run_id, parent.workspace_id, parent.conversation_id,
      agent.id, version.id, parent.requested_by, input_message_id,
      output_message_id, 'delegation', '{"type":"private"}', parent.scope,
      version.model, version.effort,
      'team:' || p_parent_run_id || ':' || delegation_key,
      p_parent_run_id, 1
    );
    INSERT INTO public.ai_usage_ledger (
      workspace_id, user_id, run_id, kind, model, tokens
    ) VALUES (
      parent.workspace_id, parent.requested_by, child_run_id,
      'reservation', version.model, 10000
    );
    INSERT INTO public.agent_team_tasks (
      workspace_id, parent_run_id, child_run_id, agent_id, ordinal,
      instruction, idempotency_key
    ) VALUES (
      parent.workspace_id, p_parent_run_id, child_run_id, agent.id,
      ordinal, task_instruction, delegation_key
    ) RETURNING * INTO existing;

    task_count := task_count + 1;
    returned_child_ids := array_append(returned_child_ids, child_run_id);
    output := output || jsonb_build_object(
      'task_id', existing.id,
      'child_run_id', child_run_id,
      'agent_id', agent.id,
      'reused', false
    );
  END LOOP;
  RETURN output;
END $$;

-- Finalize a child that the coordinator persisted but did not start because
-- its parent was cancelled or ran out of time. agent_finish_run releases its
-- usage reservation; agent_settle_team_task mirrors that terminal state.
CREATE OR REPLACE FUNCTION public.agent_terminalize_team_task(
  p_task_id uuid, p_status text, p_error_code text, p_error_message text
) RETURNS public.agent_team_tasks
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  team_task public.agent_team_tasks%ROWTYPE;
  child public.agent_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN ('cancelled', 'interrupted') THEN
    RAISE EXCEPTION 'Invalid terminal team task status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO team_task
  FROM public.agent_team_tasks
  WHERE id = p_task_id
  FOR UPDATE;
  IF team_task.id IS NULL THEN RETURN team_task; END IF;

  SELECT * INTO child
  FROM public.agent_runs
  WHERE id = team_task.child_run_id
  FOR UPDATE;
  IF child.status = 'queued' THEN
    PERFORM public.agent_finish_run(
      child.id, NULL, p_status, NULL, NULL,
      left(p_error_code, 60), left(p_error_message, 1000)
    );
  ELSIF child.status = 'running' THEN
    -- A different worker may own a reused child. Request cancellation instead
    -- of stealing its lease; that worker will finish and release it safely.
    UPDATE public.agent_runs
    SET cancel_requested_at = coalesce(cancel_requested_at, now())
    WHERE id = child.id;
  END IF;
  RETURN public.agent_settle_team_task(team_task.id);
END $$;

REVOKE ALL ON FUNCTION public.agent_delegate(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_terminalize_team_task(
  uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_delegate(uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_terminalize_team_task(
  uuid, text, text, text
) TO service_role;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
