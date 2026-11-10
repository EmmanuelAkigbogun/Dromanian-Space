-- Cancellation is a terminal intent. Once requested, no late provider result
-- may publish a reply, complete the run, or create more delegated work.

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
  IF parent.id IS NULL
     OR parent.status <> 'running'
     OR parent.cancel_requested_at IS NOT NULL THEN
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

-- A late successful provider response cannot override a prior cancellation.
CREATE OR REPLACE FUNCTION public.agent_finish_run(
  p_run_id uuid, p_worker text, p_status text, p_content text,
  p_usage jsonb, p_error_code text, p_error_message text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
  v_final text;
  v_pending integer;
  v_reserved bigint;
  v_agent text;
  v_msg_status text;
  v_content text;
  v_error_code text;
  v_error_message text;
BEGIN
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF v_run.id IS NULL THEN RETURN 'not_found'; END IF;
  IF v_run.status IN ('completed', 'failed', 'cancelled', 'interrupted', 'awaiting_approval') THEN
    RETURN v_run.status;
  END IF;
  IF v_run.status = 'running'
     AND v_run.worker IS DISTINCT FROM p_worker
     AND p_worker IS NOT NULL THEN
    RETURN 'not_owner';
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.agent_action_proposals
  WHERE run_id = p_run_id AND status = 'pending';

  v_final := CASE
    WHEN v_run.cancel_requested_at IS NOT NULL THEN 'cancelled'
    WHEN p_status = 'completed' AND v_pending > 0 THEN 'awaiting_approval'
    ELSE p_status
  END;
  IF v_final NOT IN ('awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted') THEN
    v_final := 'failed';
  END IF;
  v_msg_status := CASE v_final
    WHEN 'awaiting_approval' THEN 'complete'
    WHEN 'completed' THEN 'complete'
    ELSE v_final
  END;
  -- Preserve the latest checkpoint if a caller tries to commit a completed
  -- answer after cancellation. Explicit cancellation may still save partials.
  v_content := CASE
    WHEN v_run.cancel_requested_at IS NOT NULL AND p_status <> 'cancelled' THEN NULL
    ELSE p_content
  END;
  v_error_code := CASE
    WHEN v_final = 'cancelled' THEN coalesce(left(p_error_code, 60), 'cancelled')
    ELSE left(p_error_code, 60)
  END;
  v_error_message := CASE
    WHEN v_final = 'cancelled' THEN coalesce(left(p_error_message, 1000), 'Stopped.')
    ELSE left(p_error_message, 1000)
  END;

  UPDATE public.agent_runs
  SET status = v_final,
      finished_at = now(),
      heartbeat_at = now(),
      usage = coalesce(p_usage, usage),
      error_code = v_error_code,
      error_message = v_error_message
  WHERE id = p_run_id;
  UPDATE public.agent_messages
  SET content = CASE WHEN v_content IS NULL THEN content ELSE left(v_content, 200000) END,
      status = v_msg_status,
      updated_at = now()
  WHERE id = v_run.output_message_id;
  IF v_final = 'cancelled' THEN
    UPDATE public.agent_action_proposals
    SET status = 'cancelled', error = 'Run cancelled'
    WHERE run_id = p_run_id AND status = 'pending';
  END IF;

  SELECT coalesce(sum(tokens), 0) INTO v_reserved
  FROM public.ai_usage_ledger
  WHERE run_id = p_run_id AND kind IN ('reservation', 'release');
  IF v_reserved <> 0 THEN
    INSERT INTO public.ai_usage_ledger (
      workspace_id, user_id, run_id, kind, model, tokens
    ) VALUES (
      v_run.workspace_id, v_run.requested_by, p_run_id,
      'release', v_run.model, -v_reserved
    );
  END IF;
  IF p_usage IS NOT NULL AND p_usage <> '{}'::jsonb THEN
    INSERT INTO public.ai_usage_ledger (
      workspace_id, user_id, run_id, kind, model, tokens,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd
    ) VALUES (
      v_run.workspace_id, v_run.requested_by, p_run_id,
      CASE WHEN v_final = 'failed' THEN 'failure' ELSE 'usage' END,
      coalesce(p_usage ->> 'model', v_run.model),
      coalesce((p_usage ->> 'input_tokens')::bigint, 0)
        + coalesce((p_usage ->> 'output_tokens')::bigint, 0)
        + coalesce((p_usage ->> 'cache_write_tokens')::bigint, 0),
      coalesce((p_usage ->> 'input_tokens')::bigint, 0),
      coalesce((p_usage ->> 'output_tokens')::bigint, 0),
      coalesce((p_usage ->> 'cache_read_tokens')::bigint, 0),
      coalesce((p_usage ->> 'cache_write_tokens')::bigint, 0),
      (p_usage ->> 'cost_usd')::numeric
    );
  END IF;

  SELECT name INTO v_agent
  FROM public.workspace_agents
  WHERE id = v_run.agent_id;
  IF v_final = 'awaiting_approval' THEN
    INSERT INTO public.notifications (
      user_id, type, title, message, link, category,
      entity_type, entity_id, workspace_id
    ) VALUES (
      v_run.requested_by, 'approval_needed', v_agent || ' needs your approval',
      v_pending || ' proposed action' || CASE WHEN v_pending = 1 THEN '' ELSE 's' END || ' to review.',
      '/agents/conversations/' || v_run.conversation_id, 'messaging',
      'agent_run', p_run_id, v_run.workspace_id
    );
  ELSIF v_final = 'failed' AND v_run.trigger <> 'delegation' THEN
    INSERT INTO public.notifications (
      user_id, type, title, message, link, category,
      entity_type, entity_id, workspace_id
    ) VALUES (
      v_run.requested_by, 'agent_failed', v_agent || ' could not finish',
      coalesce(left(v_error_message, 200), 'The run failed.'),
      '/agents/conversations/' || v_run.conversation_id,
      'messaging', 'agent_run', p_run_id, v_run.workspace_id
    );
  ELSIF v_final = 'completed' AND v_run.trigger NOT IN ('interactive', 'delegation') THEN
    INSERT INTO public.notifications (
      user_id, type, title, message, link, category,
      entity_type, entity_id, workspace_id
    ) VALUES (
      v_run.requested_by, 'agent_completed', v_agent || ' finished',
      'Your result is ready.', '/agents/conversations/' || v_run.conversation_id,
      'messaging', 'agent_run', p_run_id, v_run.workspace_id
    );
  END IF;
  RETURN v_final;
END $$;

-- Always acquire the child run before its team task. Stale recovery already
-- takes child -> task; using the same order prevents a cancellation deadlock.
CREATE OR REPLACE FUNCTION public.agent_terminalize_team_task(
  p_task_id uuid, p_status text, p_error_code text, p_error_message text
) RETURNS public.agent_team_tasks
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  team_task public.agent_team_tasks%ROWTYPE;
  child public.agent_runs%ROWTYPE;
  child_run_id uuid;
BEGIN
  IF p_status NOT IN ('cancelled', 'interrupted') THEN
    RAISE EXCEPTION 'Invalid terminal team task status' USING ERRCODE = '22023';
  END IF;

  SELECT task.child_run_id INTO child_run_id
  FROM public.agent_team_tasks task
  WHERE task.id = p_task_id;
  IF child_run_id IS NULL THEN RETURN team_task; END IF;

  SELECT * INTO child
  FROM public.agent_runs
  WHERE id = child_run_id
  FOR UPDATE;
  SELECT * INTO team_task
  FROM public.agent_team_tasks
  WHERE id = p_task_id
  FOR UPDATE;
  IF team_task.id IS NULL OR child.id IS NULL THEN RETURN team_task; END IF;

  IF child.status = 'queued' THEN
    PERFORM public.agent_finish_run(
      child.id, NULL, p_status, NULL, NULL,
      left(p_error_code, 60), left(p_error_message, 1000)
    );
  ELSIF child.status = 'running' THEN
    UPDATE public.agent_runs
    SET cancel_requested_at = coalesce(cancel_requested_at, now())
    WHERE id = child.id;
  END IF;
  RETURN public.agent_settle_team_task(team_task.id);
END $$;

-- Cancelling a team settles queued tasks immediately. Running specialists get
-- a cancellation request and settle when their worker exits.
CREATE OR REPLACE FUNCTION public.agent_cancel_run(p_run_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
  child record;
BEGIN
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id AND requested_by = auth.uid()
  FOR UPDATE;
  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'Run not found' USING ERRCODE = '42501';
  END IF;

  UPDATE public.agent_action_proposals
  SET status = 'cancelled', error = 'Run cancelled'
  WHERE status = 'pending'
    AND run_id IN (
      SELECT p_run_id
      UNION
      SELECT id FROM public.agent_runs WHERE parent_run_id = p_run_id
    );

  FOR child IN
    SELECT run.id, run.status, task.id AS task_id
    FROM public.agent_runs run
    LEFT JOIN public.agent_team_tasks task ON task.child_run_id = run.id
    WHERE run.parent_run_id = p_run_id
      AND run.status IN ('queued', 'running')
    ORDER BY run.id
  LOOP
    IF child.task_id IS NOT NULL THEN
      PERFORM public.agent_terminalize_team_task(
        child.task_id, 'cancelled', 'cancelled', 'Cancelled'
      );
    ELSIF child.status = 'queued' THEN
      PERFORM public.agent_finish_run(
        child.id, NULL, 'cancelled', NULL, NULL, 'cancelled', 'Cancelled'
      );
    ELSE
      UPDATE public.agent_runs
      SET cancel_requested_at = coalesce(cancel_requested_at, now())
      WHERE id = child.id;
    END IF;
  END LOOP;

  IF v_run.status = 'queued' THEN
    RETURN public.agent_finish_run(
      p_run_id, NULL, 'cancelled', NULL, NULL, 'cancelled', 'Cancelled'
    );
  ELSIF v_run.status = 'running' THEN
    UPDATE public.agent_runs
    SET cancel_requested_at = coalesce(cancel_requested_at, now())
    WHERE id = p_run_id;
    RETURN 'cancelling';
  ELSIF v_run.status = 'awaiting_approval' THEN
    UPDATE public.agent_runs
    SET status = 'cancelled', finished_at = coalesce(finished_at, now()),
        error_code = 'cancelled', error_message = 'Stopped.'
    WHERE id = p_run_id;
    RETURN 'cancelled';
  END IF;
  RETURN v_run.status;
END $$;

-- Hold the run row through reply creation so cancellation and publication are
-- serialized. A cancellation request always wins before any proposal exists.
CREATE OR REPLACE FUNCTION public.agent_publish_reply(
  p_run_id uuid, p_content text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
  v_settings public.workspace_ai_settings%ROWTYPE;
  v_args jsonb;
  v_gaps jsonb;
  v_id uuid;
  v_result jsonb;
  v_channel uuid;
  v_parent uuid;
  v_auto boolean;
BEGIN
  SELECT * INTO v_run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN
    RETURN jsonb_build_object('status', 'not_running');
  END IF;
  IF v_run.cancel_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'cancelled');
  END IF;
  IF coalesce(v_run.destination ->> 'type', 'private') <> 'channel' THEN
    RETURN jsonb_build_object('status', 'private');
  END IF;
  IF length(btrim(coalesce(p_content, ''))) = 0 THEN
    RETURN jsonb_build_object('status', 'empty');
  END IF;
  v_channel := (v_run.destination ->> 'channel_id')::uuid;
  v_parent := nullif(v_run.destination ->> 'parent_id', '')::uuid;
  IF NOT public.user_is_channel_member(v_channel, v_run.requested_by) THEN
    RETURN jsonb_build_object('status', 'private', 'reason', 'not_member');
  END IF;
  v_args := jsonb_build_object(
    'channel_id', v_channel,
    'parent_id', v_parent,
    'content', left(p_content, 20000)
  );
  v_gaps := public.agent_audience_gaps(
    p_run_id,
    public.agent_action_audience(
      v_run.workspace_id, v_run.requested_by, 'post_message', v_args
    )
  );
  IF jsonb_array_length(v_gaps) > 0 THEN
    PERFORM public.agent_add_event(
      p_run_id,
      'warning',
      jsonb_build_object(
        'code', 'kept_private',
        'message', 'Some people in this conversation cannot open sources this answer used, so it was kept private.',
        'sources', v_gaps
      )
    );
    RETURN jsonb_build_object(
      'status', 'private', 'reason', 'audience', 'sources', v_gaps
    );
  END IF;
  v_settings := public.ai_settings_for(v_run.workspace_id);
  v_auto := v_settings.mention_reply_policy = 'auto'
    OR v_run.trigger = 'session_notes';
  INSERT INTO public.agent_action_proposals (
    workspace_id, run_id, conversation_id, action_type, arguments,
    arguments_hash, summary, destination, requested_for,
    idempotency_key, status
  ) VALUES (
    v_run.workspace_id,
    p_run_id,
    v_run.conversation_id,
    'post_message',
    v_args,
    public.agent_hash_arguments(v_args),
    CASE
      WHEN v_run.trigger = 'session_notes' THEN 'Post the notes of the AI session'
      ELSE 'Reply in the conversation where the agent was mentioned'
    END,
    jsonb_build_object(
      'type', 'channel', 'channel_id', v_channel, 'parent_id', v_parent
    ),
    v_run.requested_by,
    'reply:' || p_run_id,
    CASE WHEN v_auto THEN 'executing' ELSE 'pending' END
  )
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('status', 'exists'); END IF;
  IF NOT v_auto THEN
    RETURN jsonb_build_object('status', 'proposed', 'proposal_id', v_id);
  END IF;
  BEGIN
    v_result := public.agent_execute_proposal(v_id);
    UPDATE public.agent_action_proposals
    SET status = 'executed', executed_at = now(), result = v_result,
        decided_by = v_run.requested_by, decided_at = now()
    WHERE id = v_id;
    INSERT INTO public.audit_log (
      workspace_id, actor_id, action, entity_type, entity_id, metadata
    ) VALUES (
      v_run.workspace_id, v_run.requested_by, 'agent_reply_published',
      'agent_proposal', v_id,
      jsonb_build_object(
        'policy', CASE WHEN v_run.trigger = 'session_notes' THEN 'session' ELSE 'auto' END,
        'run_id', p_run_id,
        'result', v_result
      )
    );
    RETURN jsonb_build_object(
      'status', 'published', 'proposal_id', v_id, 'result', v_result
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.agent_action_proposals
    SET status = 'failed', error = left(SQLERRM, 500)
    WHERE id = v_id;
    RETURN jsonb_build_object('status', 'failed', 'error', left(SQLERRM, 200));
  END;
END $$;

REVOKE ALL ON FUNCTION public.agent_delegate(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_finish_run(
  uuid, text, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_terminalize_team_task(
  uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_publish_reply(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_delegate(uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_finish_run(
  uuid, text, text, text, jsonb, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_terminalize_team_task(
  uuid, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_publish_reply(uuid, text)
  TO service_role;

-- Users retain only the authenticated cancellation entry point.
REVOKE ALL ON FUNCTION public.agent_cancel_run(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_cancel_run(uuid)
  TO authenticated, service_role;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
