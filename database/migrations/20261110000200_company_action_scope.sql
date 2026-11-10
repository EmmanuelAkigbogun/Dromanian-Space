-- Make the selected managed company a hard boundary for every agent file read
-- and reviewed write. Explicit source IDs remain a separate, optional
-- restriction; the server no longer expands the full company Drive tree into
-- prompts or RPC array parameters.

ALTER TABLE public.task_requests
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.crm_companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_task_requests_company
  ON public.task_requests (workspace_id, company_id, created_at DESC)
  WHERE company_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.agent_company_drive_contains_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid, p_item_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  RETURN EXISTS (
    SELECT 1
    FROM public.agent_company_drive_item_ids_for(p_actor, p_workspace_id, p_company_id) scoped
    WHERE scoped.id = p_item_id
  );
END $$;

DO $$ BEGIN
  IF to_regprocedure('public.agent_execute_proposal_pre_company(uuid)') IS NULL THEN
    ALTER FUNCTION public.agent_execute_proposal(uuid)
      RENAME TO agent_execute_proposal_pre_company;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.agent_execute_proposal_pre_company(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.agent_execute_proposal(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  proposal public.agent_action_proposals%ROWTYPE;
  run public.agent_runs%ROWTYPE;
  run_company_id uuid;
  normalized jsonb;
  post jsonb;
  post_id uuid;
  post_ids uuid[] := '{}';
  body text;
  result jsonb;
  gaps jsonb;
BEGIN
  SELECT * INTO proposal
  FROM public.agent_action_proposals
  WHERE id = p_id;
  IF proposal.id IS NULL THEN
    RAISE EXCEPTION 'Proposal not found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO run FROM public.agent_runs WHERE id = proposal.run_id;
  run_company_id := nullif(run.scope ->> 'company_id', '')::uuid;
  IF run_company_id IS NULL THEN
    RETURN public.agent_execute_proposal_pre_company(p_id);
  END IF;
  normalized := public.agent_company_action_arguments(
    proposal.run_id, proposal.action_type, proposal.arguments
  );

  IF proposal.action_type = 'create_social_drafts' THEN
    IF NOT public.user_is_workspace_member(
      proposal.workspace_id, proposal.requested_for
    ) OR NOT public.feature_visible_to(
      proposal.workspace_id, proposal.requested_for, 'social'
    ) THEN
      RAISE EXCEPTION 'Social is no longer available to the requester'
        USING ERRCODE = '42501';
    END IF;
    gaps := public.agent_audience_gaps(
      proposal.run_id,
      public.agent_action_audience(
        proposal.workspace_id, proposal.requested_for,
        proposal.action_type, normalized
      )
    );
    IF jsonb_array_length(gaps) > 0 THEN
      RAISE EXCEPTION 'Some people who would see this cannot open its sources anymore'
        USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(normalized -> 'posts') <> 'array'
       OR jsonb_array_length(normalized -> 'posts') NOT BETWEEN 1 AND 31 THEN
      RAISE EXCEPTION 'Provide between 1 and 31 Social drafts'
        USING ERRCODE = '22023';
    END IF;
    FOR post IN SELECT value FROM jsonb_array_elements(normalized -> 'posts')
    LOOP
      body := btrim(coalesce(post ->> 'body', ''));
      IF length(body) NOT BETWEEN 1 AND 10000 THEN
        RAISE EXCEPTION 'Each Social draft needs 1 to 10000 characters'
          USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.social_posts (
        workspace_id, company_id, body, link, scheduled_at, status, created_by
      ) VALUES (
        proposal.workspace_id, run_company_id, body,
        nullif(btrim(coalesce(post ->> 'link', '')), ''),
        nullif(post ->> 'scheduled_at', '')::timestamptz,
        'draft', proposal.requested_for
      ) RETURNING id INTO post_id;
      post_ids := array_append(post_ids, post_id);
      INSERT INTO public.audit_log (
        workspace_id, actor_id, action, entity_type, entity_id, metadata
      ) VALUES (
        proposal.workspace_id, proposal.requested_for,
        'create_social_draft', 'social_post', post_id,
        jsonb_build_object(
          'source', 'agent', 'proposal_id', proposal.id,
          'company_id', run_company_id
        )
      );
    END LOOP;
    RETURN jsonb_build_object(
      'post_ids', to_jsonb(post_ids), 'link', '/social',
      'company_id', run_company_id
    );
  END IF;

  result := public.agent_execute_proposal_pre_company(p_id);
  IF proposal.action_type = 'create_task'
     AND nullif(result ->> 'task_id', '') IS NOT NULL THEN
    INSERT INTO public.crm_links (
      workspace_id, company_id, task_id, created_by
    )
    SELECT proposal.workspace_id, run_company_id,
           (result ->> 'task_id')::uuid, proposal.requested_for
    WHERE NOT EXISTS (
      SELECT 1 FROM public.crm_links link
      WHERE link.workspace_id = proposal.workspace_id
        AND link.company_id = run_company_id
        AND link.task_id = (result ->> 'task_id')::uuid
    );
  END IF;
  RETURN result;
END $$;

-- Persist the selected company with manager-reviewed task requests. The
-- project and source conversation are validated before the request exists.
CREATE OR REPLACE FUNCTION public.agent_submit_task_requests(
  p_run_id uuid, p_tool_use_id text, p_tasks jsonb, p_source_label text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  run public.agent_runs%ROWTYPE;
  task jsonb;
  ordinal integer := 0;
  inserted integer := 0;
  request_id uuid;
  request_ids uuid[] := '{}';
  assignees uuid[];
  project_id uuid;
  channel_id uuid;
  company_id uuid;
  approvers uuid[];
  agent_name text;
  requester_name text;
  request_key text;
BEGIN
  SELECT * INTO run FROM public.agent_runs WHERE id = p_run_id;
  IF run.id IS NULL OR run.status <> 'running' THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_tasks) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_tasks) NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'Submit between 1 and 25 tasks' USING ERRCODE = '22023';
  END IF;
  company_id := nullif(run.scope ->> 'company_id', '')::uuid;
  PERFORM public.crm_validate_agent_client(
    run.requested_by, run.workspace_id, company_id
  );
  channel_id := nullif(run.scope ->> 'channel_id', '')::uuid;
  IF channel_id IS NOT NULL
     AND NOT public.user_is_channel_member(channel_id, run.requested_by) THEN
    channel_id := NULL;
  END IF;
  IF company_id IS NOT NULL AND channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.agent_channels_scoped_for(
      run.requested_by, run.workspace_id, company_id
    ) channel
    WHERE channel.id = channel_id
  ) THEN
    RAISE EXCEPTION 'The task source conversation is outside the selected managed company'
      USING ERRCODE = '42501';
  END IF;

  FOR task IN SELECT value FROM jsonb_array_elements(p_tasks) LOOP
    ordinal := ordinal + 1;
    assignees := ARRAY(
      SELECT DISTINCT value::uuid
      FROM jsonb_array_elements_text(
        coalesce(task -> 'assignee_ids', '[]'::jsonb)
      ) value
    );
    IF EXISTS (
      SELECT 1 FROM unnest(assignees) assignee
      WHERE NOT public.user_is_workspace_member(run.workspace_id, assignee)
    ) THEN
      RAISE EXCEPTION 'An assignee is not a workspace member'
        USING ERRCODE = '42501';
    END IF;
    project_id := nullif(task ->> 'project_id', '')::uuid;
    IF project_id IS NOT NULL AND (
      public.get_project_workspace_id(project_id) IS DISTINCT FROM run.workspace_id
      OR NOT public.is_project_readable(project_id, run.requested_by)
    ) THEN
      RAISE EXCEPTION 'The requester cannot open that project'
        USING ERRCODE = '42501';
    END IF;
    IF company_id IS NOT NULL AND project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.agent_projects_scoped_for(
        run.requested_by, run.workspace_id, company_id
      ) project
      WHERE project.id = project_id
    ) THEN
      RAISE EXCEPTION 'The task project is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
    request_key := 'agent:' || p_run_id || ':' || p_tool_use_id || ':' || ordinal;
    request_id := NULL;
    INSERT INTO public.task_requests (
      workspace_id, company_id, title, description, priority, due_date,
      project_id, assignee_ids, source_channel_id, source_label,
      submitted_by, agent_id, agent_run_id, idempotency_key
    ) VALUES (
      run.workspace_id, company_id,
      left(btrim(task ->> 'title'), 300),
      left(nullif(btrim(task ->> 'description'), ''), 8000),
      coalesce(nullif(task ->> 'priority', ''), 'medium'),
      nullif(task ->> 'due_date', '')::timestamptz,
      project_id, assignees, channel_id,
      left(nullif(btrim(p_source_label), ''), 200),
      run.requested_by, run.agent_id, p_run_id, request_key
    )
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
    RETURNING id INTO request_id;
    IF request_id IS NULL THEN
      SELECT id INTO request_id
      FROM public.task_requests
      WHERE workspace_id = run.workspace_id
        AND task_requests.idempotency_key = request_key;
    ELSE
      inserted := inserted + 1;
    END IF;
    request_ids := request_ids || request_id;
  END LOOP;

  approvers := public.task_approver_ids(run.workspace_id);
  IF inserted > 0 THEN
    SELECT name INTO agent_name
    FROM public.workspace_agents WHERE id = run.agent_id;
    SELECT coalesce(display_name, username) INTO requester_name
    FROM public.profiles WHERE id = run.requested_by;
    INSERT INTO public.notifications (
      user_id, type, title, message, link, category, entity_type,
      actor_id, workspace_id
    )
    SELECT approver, 'task_approval',
           inserted || CASE WHEN inserted = 1 THEN ' task needs'
                            ELSE ' tasks need' END || ' your approval',
           left(
             coalesce(agent_name, 'An agent') || ' prepared ' || inserted
             || CASE WHEN inserted = 1 THEN ' task' ELSE ' tasks' END
             || ' for ' || coalesce(requester_name, 'a member')
             || coalesce(' from ' || nullif(btrim(p_source_label), ''), '')
             || '.', 1000
           ),
           '/tasks?view=approvals', 'tasks', 'task',
           run.requested_by, run.workspace_id
    FROM unnest(approvers) approver
    WHERE approver <> run.requested_by;
  END IF;
  RETURN jsonb_build_object(
    'status', 'submitted', 'request_ids', to_jsonb(request_ids),
    'new', inserted, 'approvers', coalesce(array_length(approvers, 1), 0),
    'requester_is_approver', run.requested_by = ANY(approvers),
    'company_id', company_id
  );
END $$;

DO $$ BEGIN
  IF to_regprocedure(
    'public.decide_task_request_pre_company(uuid,boolean,jsonb,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.decide_task_request(uuid, boolean, jsonb, text)
      RENAME TO decide_task_request_pre_company;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.decide_task_request_pre_company(
  uuid, boolean, jsonb, text
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.decide_task_request(
  p_request_id uuid, p_approve boolean,
  p_changes jsonb DEFAULT '{}'::jsonb, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  request public.task_requests%ROWTYPE;
  actor uuid := auth.uid();
  project_id uuid;
  result jsonb;
  created_task_id uuid;
BEGIN
  SELECT * INTO request
  FROM public.task_requests
  WHERE id = p_request_id;
  IF request.id IS NULL
     OR NOT public.user_is_workspace_member(request.workspace_id, actor)
     OR NOT public.is_task_approver(request.workspace_id, actor) THEN
    RAISE EXCEPTION 'Task request not found' USING ERRCODE = '42501';
  END IF;
  IF p_approve AND request.company_id IS NOT NULL THEN
    PERFORM public.crm_validate_agent_client(
      actor, request.workspace_id, request.company_id
    );
    project_id := CASE WHEN coalesce(p_changes, '{}'::jsonb) ? 'project_id'
      THEN nullif(p_changes ->> 'project_id', '')::uuid
      ELSE request.project_id
    END;
    IF project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.agent_projects_scoped_for(
        actor, request.workspace_id, request.company_id
      ) project
      WHERE project.id = project_id
    ) THEN
      RAISE EXCEPTION 'The task project is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  result := public.decide_task_request_pre_company(
    p_request_id, p_approve, p_changes, p_note
  );
  created_task_id := nullif(result ->> 'task_id', '')::uuid;
  IF request.company_id IS NOT NULL
     AND result ->> 'status' = 'approved'
     AND created_task_id IS NOT NULL THEN
    INSERT INTO public.crm_links (
      workspace_id, company_id, task_id, created_by
    )
    SELECT request.workspace_id, request.company_id, created_task_id, actor
    WHERE NOT EXISTS (
      SELECT 1 FROM public.crm_links link
      WHERE link.workspace_id = request.workspace_id
        AND link.company_id = request.company_id
        AND link.task_id = created_task_id
    );
  END IF;
  RETURN result;
END $$;


-- Normalize and validate a proposed write against the immutable run scope.
-- The model's company_id is never authoritative.
CREATE OR REPLACE FUNCTION public.agent_company_action_arguments(
  p_run_id uuid, p_action_type text, p_arguments jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  run public.agent_runs%ROWTYPE;
  company_id uuid;
  project_id uuid;
  channel_id uuid;
  item_id uuid;
  folder_id uuid;
  normalized jsonb := coalesce(p_arguments, '{}'::jsonb);
BEGIN
  SELECT * INTO run FROM public.agent_runs WHERE id = p_run_id;
  IF run.id IS NULL THEN
    RAISE EXCEPTION 'Run not found' USING ERRCODE = '42501';
  END IF;
  company_id := nullif(run.scope ->> 'company_id', '')::uuid;
  IF company_id IS NULL THEN RETURN normalized; END IF;
  PERFORM public.crm_validate_agent_client(
    run.requested_by, run.workspace_id, company_id
  );
  normalized := normalized || jsonb_build_object('company_id', company_id);

  IF p_action_type = 'create_task' THEN
    project_id := nullif(normalized ->> 'project_id', '')::uuid;
    IF project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.agent_projects_scoped_for(
        run.requested_by, run.workspace_id, company_id
      ) project
      WHERE project.id = project_id
    ) THEN
      RAISE EXCEPTION 'The task project is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
    channel_id := nullif(normalized ->> 'source_channel_id', '')::uuid;
    IF channel_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.agent_channels_scoped_for(
        run.requested_by, run.workspace_id, company_id
      ) channel
      WHERE channel.id = channel_id
    ) THEN
      RAISE EXCEPTION 'The task source conversation is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
  ELSIF p_action_type IN ('save_document', 'create_drive_folder') THEN
    folder_id := nullif(normalized ->> 'folder_id', '')::uuid;
    IF folder_id IS NULL OR NOT public.agent_company_drive_contains_for(
      run.requested_by, run.workspace_id, company_id, folder_id
    ) THEN
      RAISE EXCEPTION 'Choose a folder inside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
  ELSIF p_action_type = 'rename_drive_item' THEN
    item_id := nullif(normalized ->> 'item_id', '')::uuid;
    IF item_id IS NULL OR NOT public.agent_company_drive_contains_for(
      run.requested_by, run.workspace_id, company_id, item_id
    ) THEN
      RAISE EXCEPTION 'The Drive item is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
  ELSIF p_action_type = 'move_drive_item' THEN
    item_id := nullif(normalized ->> 'item_id', '')::uuid;
    folder_id := nullif(normalized ->> 'folder_id', '')::uuid;
    IF item_id IS NULL OR NOT public.agent_company_drive_contains_for(
      run.requested_by, run.workspace_id, company_id, item_id
    ) THEN
      RAISE EXCEPTION 'The Drive item is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
    IF folder_id IS NULL OR NOT public.agent_company_drive_contains_for(
      run.requested_by, run.workspace_id, company_id, folder_id
    ) THEN
      RAISE EXCEPTION 'Choose a destination inside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
  ELSIF p_action_type = 'update_crm_record' THEN
    PERFORM public.crm_read_for_context(
      run.requested_by, run.workspace_id, company_id,
      normalized ->> 'kind', (normalized ->> 'record_id')::uuid
    );
  ELSIF p_action_type = 'post_message' THEN
    channel_id := nullif(normalized ->> 'channel_id', '')::uuid;
    IF channel_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.agent_channels_scoped_for(
        run.requested_by, run.workspace_id, company_id
      ) channel
      WHERE channel.id = channel_id
    ) THEN
      RAISE EXCEPTION 'The destination conversation is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
  ELSIF p_action_type = 'create_social_drafts' THEN
    normalized := jsonb_set(
      normalized,
      '{posts}',
      coalesce((
        SELECT jsonb_agg(
          (post.value - 'company_id') || jsonb_build_object('company_id', company_id)
          ORDER BY post.ordinality
        )
        FROM jsonb_array_elements(coalesce(normalized -> 'posts', '[]'::jsonb))
             WITH ORDINALITY AS post(value, ordinality)
      ), '[]'::jsonb),
      true
    );
  END IF;
  RETURN normalized;
END $$;

-- Proposal cards are persisted with normalized company arguments so the
-- approver reviews the same boundary the executor will enforce.
CREATE OR REPLACE FUNCTION public.agent_create_proposal(
  p_run_id uuid, p_tool_use_id text, p_action_type text,
  p_arguments jsonb, p_summary text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  run public.agent_runs%ROWTYPE;
  gaps jsonb;
  proposal_id uuid;
  invocation_id uuid;
  existing public.agent_action_proposals%ROWTYPE;
  destination jsonb;
BEGIN
  SELECT * INTO run FROM public.agent_runs WHERE id = p_run_id;
  IF run.id IS NULL OR run.status <> 'running' THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;
  p_arguments := public.agent_company_action_arguments(
    p_run_id, p_action_type, p_arguments
  );
  SELECT * INTO existing
  FROM public.agent_action_proposals
  WHERE run_id = p_run_id
    AND (
      idempotency_key = p_run_id || ':' || p_tool_use_id
      OR (
        arguments_hash = public.agent_hash_arguments(p_arguments)
        AND action_type = p_action_type
        AND status IN ('pending', 'executing', 'executed')
      )
    )
  LIMIT 1;
  IF existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'proposed', 'proposal_id', existing.id, 'reused', true
    );
  END IF;
  IF p_action_type = 'post_message'
     AND NOT public.user_is_channel_member(
       (p_arguments ->> 'channel_id')::uuid, run.requested_by
     ) THEN
    RETURN jsonb_build_object(
      'status', 'denied',
      'reason', 'The requester is not a member of that conversation.'
    );
  END IF;
  gaps := public.agent_audience_gaps(
    p_run_id,
    public.agent_action_audience(
      run.workspace_id, run.requested_by, p_action_type, p_arguments
    )
  );
  IF jsonb_array_length(gaps) > 0 THEN
    RETURN jsonb_build_object(
      'status', 'blocked_audience', 'sources', gaps,
      'reason', 'Some people who would see this result cannot open sources it was based on. Keep the result private, or share those sources first.'
    );
  END IF;
  destination := CASE p_action_type
    WHEN 'post_message' THEN jsonb_build_object(
      'type', 'channel', 'channel_id', p_arguments ->> 'channel_id',
      'parent_id', p_arguments ->> 'parent_id'
    )
    WHEN 'create_task' THEN jsonb_build_object(
      'type', 'task', 'project_id', p_arguments ->> 'project_id'
    )
    WHEN 'save_document' THEN jsonb_build_object(
      'type', 'drive', 'folder_id', p_arguments ->> 'folder_id'
    )
    WHEN 'create_event' THEN jsonb_build_object('type', 'calendar')
    ELSE jsonb_build_object('type', p_action_type)
  END;
  SELECT id INTO invocation_id
  FROM public.agent_tool_invocations
  WHERE run_id = p_run_id AND provider_tool_use_id = p_tool_use_id;
  INSERT INTO public.agent_action_proposals (
    workspace_id, run_id, conversation_id, invocation_id, action_type,
    arguments, arguments_hash, summary, destination, requested_for,
    idempotency_key
  ) VALUES (
    run.workspace_id, p_run_id, run.conversation_id, invocation_id,
    p_action_type, p_arguments, public.agent_hash_arguments(p_arguments),
    left(p_summary, 500), destination, run.requested_by,
    p_run_id || ':' || p_tool_use_id
  ) RETURNING id INTO proposal_id;
  RETURN jsonb_build_object('status', 'proposed', 'proposal_id', proposal_id);
END $$;


-- Exact selected-source metadata, with the managed-company test applied in the
-- database rather than by materializing every company item in the worker.
CREATE OR REPLACE FUNCTION public.agent_scope_items_scoped_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid, p_item_ids uuid[]
) RETURNS TABLE(
  id uuid, name text, kind text, mime_type text, workspace_id uuid,
  index_status text, index_message text, truncated boolean, chunk_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  IF coalesce(cardinality(p_item_ids), 0) > 100 THEN
    RAISE EXCEPTION 'Too many selected Drive sources' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT item.id, item.name, item.kind, item.mime_type, item.workspace_id,
         source.status, source.error_message, coalesce(source.truncated, false), source.chunk_count
  FROM public.drive_items item
  LEFT JOIN LATERAL (
    SELECT latest.status, latest.error_message, latest.truncated, latest.chunk_count
    FROM public.knowledge_sources latest
    WHERE latest.item_id = item.id AND latest.superseded_at IS NULL
    ORDER BY latest.created_at DESC
    LIMIT 1
  ) source ON true
  WHERE item.workspace_id = p_workspace_id
    AND item.id = ANY(coalesce(p_item_ids, '{}'::uuid[]))
    AND public.drive_viewable_by(item.id, p_actor)
    AND (p_company_id IS NULL OR public.agent_company_drive_contains_for(
      p_actor, p_workspace_id, p_company_id, item.id
    ));
END $$;

CREATE OR REPLACE FUNCTION public.agent_file_scoped_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid, p_item_id uuid
) RETURNS TABLE(
  item_id uuid, name text, version_id uuid, bucket text, path text,
  mime_type text, size_bytes bigint, workspace_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  RETURN QUERY
  SELECT file.item_id, file.name, file.version_id, file.bucket, file.path,
         file.mime_type, file.size_bytes, file.workspace_id
  FROM public.agent_file_for(p_actor, p_item_id) file
  WHERE file.workspace_id = p_workspace_id
    AND (p_company_id IS NULL OR public.agent_company_drive_contains_for(
      p_actor, p_workspace_id, p_company_id, file.item_id
    ));
END $$;

CREATE OR REPLACE FUNCTION public.agent_brand_kit_items_scoped_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid
) RETURNS TABLE(id uuid, name text, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  RETURN QUERY
  SELECT item.id, item.name, item.kind
  FROM public.agent_brand_kit_items_for(p_actor, p_workspace_id) item
  WHERE p_company_id IS NULL OR public.agent_company_drive_contains_for(
    p_actor, p_workspace_id, p_company_id, item.id
  );
END $$;

-- Hybrid retrieval with both boundaries applied before ranking and LIMIT.
CREATE OR REPLACE FUNCTION public.agent_knowledge_search_scoped_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid, p_query text,
  p_item_ids uuid[] DEFAULT NULL, p_limit integer DEFAULT 8,
  p_query_embedding extensions.vector DEFAULT NULL,
  p_embedding_model text DEFAULT NULL
) RETURNS TABLE(
  chunk_id uuid, item_id uuid, source_id uuid, version_id uuid,
  revision_id uuid, item_name text, chunk_index integer, content text,
  location jsonb, score double precision, match text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE v_tsq tsquery;
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  IF coalesce(cardinality(p_item_ids), 0) > 100 THEN
    RAISE EXCEPTION 'Too many selected Drive sources' USING ERRCODE = '22023';
  END IF;
  SELECT to_tsquery('simple', string_agg(quote_literal(lex), ' | '))
  INTO v_tsq
  FROM unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) AS lex;
  v_tsq := coalesce(v_tsq, ''::tsquery);

  RETURN QUERY
  WITH allowed AS (
    SELECT source.id AS source_id, source.item_id, source.version_id, source.revision_id
    FROM public.knowledge_sources source
    WHERE source.workspace_id = p_workspace_id
      AND source.status = 'ready'
      AND source.superseded_at IS NULL
      AND (p_item_ids IS NULL OR source.item_id = ANY(p_item_ids))
      AND public.drive_viewable_by(source.item_id, p_actor)
      AND (p_company_id IS NULL OR EXISTS (
        SELECT 1
        FROM public.agent_company_drive_item_ids_for(
          p_actor, p_workspace_id, p_company_id
        ) scoped
        WHERE scoped.id = source.item_id
      ))
  ), fts AS (
    SELECT chunk.id, ts_rank_cd(chunk.tsv, v_tsq) AS rank,
           row_number() OVER (
             ORDER BY ts_rank_cd(chunk.tsv, v_tsq) DESC, chunk.chunk_index
           ) AS rn
    FROM public.knowledge_chunks chunk
    JOIN allowed ON allowed.source_id = chunk.source_id
    WHERE numnode(v_tsq) > 0 AND chunk.tsv @@ v_tsq
    ORDER BY rank DESC
    LIMIT 60
  ), vec AS (
    SELECT chunk.id, 1 - (embedding.embedding <=> p_query_embedding) AS sim,
           row_number() OVER (
             ORDER BY embedding.embedding <=> p_query_embedding
           ) AS rn
    FROM public.knowledge_chunks chunk
    JOIN allowed ON allowed.source_id = chunk.source_id
    JOIN public.knowledge_embeddings embedding
      ON embedding.chunk_id = chunk.id
     AND embedding.model = p_embedding_model
     AND embedding.dimensions = vector_dims(p_query_embedding)
    WHERE p_query_embedding IS NOT NULL
    ORDER BY embedding.embedding <=> p_query_embedding
    LIMIT 60
  ), fused AS (
    SELECT coalesce(fts.id, vec.id) AS id,
           coalesce(1.0 / (60 + fts.rn), 0)
             + coalesce(1.0 / (60 + vec.rn), 0) AS score,
           CASE WHEN fts.id IS NOT NULL AND vec.id IS NOT NULL THEN 'hybrid'
                WHEN fts.id IS NOT NULL THEN 'keyword' ELSE 'semantic' END AS match
    FROM fts FULL OUTER JOIN vec ON vec.id = fts.id
  )
  SELECT chunk.id, chunk.item_id, chunk.source_id, allowed.version_id,
         allowed.revision_id, item.name, chunk.chunk_index, chunk.content,
         chunk.location, fused.score::double precision, fused.match
  FROM fused
  JOIN public.knowledge_chunks chunk ON chunk.id = fused.id
  JOIN allowed ON allowed.source_id = chunk.source_id
  JOIN public.drive_items item ON item.id = chunk.item_id
  ORDER BY fused.score DESC, chunk.chunk_index
  LIMIT least(greatest(coalesce(p_limit, 8), 1), 40);
END $$;

CREATE OR REPLACE FUNCTION public.agent_knowledge_read_item_scoped_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid, p_item_id uuid,
  p_from_chunk integer DEFAULT 0, p_max_chunks integer DEFAULT 12
) RETURNS TABLE(
  chunk_id uuid, source_id uuid, version_id uuid, revision_id uuid,
  item_name text, chunk_index integer, content text, location jsonb,
  total_chunks integer, source_status text, truncated boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  IF p_company_id IS NOT NULL AND NOT public.agent_company_drive_contains_for(
    p_actor, p_workspace_id, p_company_id, p_item_id
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT *
  FROM public.knowledge_read_item_for(
    p_actor, p_item_id, p_from_chunk, p_max_chunks
  );
END $$;

-- Add explicit selected-source filtering to company Drive browsing before the
-- LIMIT. The company folder remains the hard outer boundary.
DROP FUNCTION IF EXISTS public.agent_list_company_drive_for(
  uuid, uuid, uuid, text, uuid, integer
);
DROP FUNCTION IF EXISTS public.agent_list_company_drive_for(
  uuid, uuid, uuid, text, uuid, integer, uuid[]
);
CREATE OR REPLACE FUNCTION public.agent_list_company_drive_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid,
  p_query text DEFAULT NULL, p_folder_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100, p_item_ids uuid[] DEFAULT NULL
) RETURNS TABLE(
  id uuid, kind text, name text, mime_type text, parent_id uuid,
  my_role text, owner_id uuid, updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE v_root_id uuid;
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  IF coalesce(cardinality(p_item_ids), 0) > 100 THEN
    RAISE EXCEPTION 'Too many selected Drive sources' USING ERRCODE = '22023';
  END IF;
  SELECT company.drive_folder_id INTO v_root_id
  FROM public.crm_companies company
  WHERE company.id = p_company_id AND company.workspace_id = p_workspace_id;
  IF v_root_id IS NULL THEN RETURN; END IF;

  IF p_folder_id IS NOT NULL AND NOT public.agent_company_drive_contains_for(
    p_actor, p_workspace_id, p_company_id, p_folder_id
  ) THEN
    RAISE EXCEPTION 'Company folder not found' USING ERRCODE = '42501';
  END IF;
  IF p_folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.drive_items folder
    WHERE folder.id = p_folder_id AND folder.kind = 'folder'
  ) THEN
    RAISE EXCEPTION 'Company folder not found' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH RECURSIVE company_drive AS (
    SELECT item.id, ARRAY[item.id]::uuid[] AS path
    FROM public.drive_items item
    WHERE item.id = v_root_id
      AND item.workspace_id = p_workspace_id
      AND item.trashed_at IS NULL
      AND item.purge_requested_at IS NULL
    UNION ALL
    SELECT child.id, parent.path || child.id
    FROM company_drive parent
    JOIN public.drive_items child
      ON child.parent_id = parent.id
     AND child.workspace_id = p_workspace_id
    WHERE child.trashed_at IS NULL
      AND child.purge_requested_at IS NULL
      AND NOT child.id = ANY(parent.path)
      AND cardinality(parent.path) < 100
  )
  SELECT item.id, item.kind, item.name, item.mime_type, item.parent_id,
         public.drive_role_for(item.id, p_actor), item.owner_id, item.updated_at
  FROM company_drive scoped
  JOIN public.drive_items item ON item.id = scoped.id
  WHERE (item.kind <> 'file' OR item.current_version_id IS NOT NULL)
    AND public.drive_role_for(item.id, p_actor) IS NOT NULL
    AND (p_folder_id IS NULL OR item.parent_id = p_folder_id)
    AND (p_item_ids IS NULL OR item.id = ANY(p_item_ids))
    AND (nullif(btrim(p_query), '') IS NULL
      OR lower(item.name) LIKE '%' || lower(btrim(p_query)) || '%')
  ORDER BY CASE WHEN item.kind = 'folder' THEN 0 ELSE 1 END,
           item.updated_at DESC, lower(item.name), item.id
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END $$;

REVOKE ALL ON FUNCTION public.agent_company_drive_contains_for(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_scope_items_scoped_for(uuid, uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_file_scoped_for(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_brand_kit_items_scoped_for(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_knowledge_search_scoped_for(
  uuid, uuid, uuid, text, uuid[], integer, extensions.vector, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_knowledge_read_item_scoped_for(
  uuid, uuid, uuid, uuid, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_list_company_drive_for(
  uuid, uuid, uuid, text, uuid, integer, uuid[]
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_company_action_arguments(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_create_proposal(uuid, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_execute_proposal(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_task_request(uuid, boolean, jsonb, text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.agent_company_drive_contains_for(uuid, uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_scope_items_scoped_for(uuid, uuid, uuid, uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_file_scoped_for(uuid, uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_brand_kit_items_scoped_for(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_knowledge_search_scoped_for(
  uuid, uuid, uuid, text, uuid[], integer, extensions.vector, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_knowledge_read_item_scoped_for(
  uuid, uuid, uuid, uuid, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_list_company_drive_for(
  uuid, uuid, uuid, text, uuid, integer, uuid[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_company_action_arguments(uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_create_proposal(uuid, text, text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_execute_proposal(uuid),
  public.agent_execute_proposal_pre_company(uuid),
  public.decide_task_request_pre_company(uuid, boolean, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.decide_task_request(uuid, boolean, jsonb, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
