CREATE OR REPLACE FUNCTION crm_read_for(p_actor uuid,p_workspace_id uuid,p_kind text,p_record_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
 IF NOT user_is_workspace_member(p_workspace_id,p_actor) OR p_kind NOT IN ('contacts','companies','deals') THEN RAISE EXCEPTION 'Record not found' USING ERRCODE='42501'; END IF;
 EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE id=$1 AND workspace_id=$2','crm_'||p_kind) INTO v USING p_record_id,p_workspace_id;
 IF v IS NULL THEN RAISE EXCEPTION 'Record not found' USING ERRCODE='42501'; END IF;
 RETURN v;
END $$;
CREATE OR REPLACE FUNCTION crm_update_for(p_actor uuid,p_workspace_id uuid,p_kind text,p_record_id uuid,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb; v_table text;
BEGIN
 v:=crm_read_for(p_actor,p_workspace_id,p_kind,p_record_id);
 IF NOT (v->>'owner_id'=p_actor::text OR v->>'created_by'=p_actor::text OR user_is_workspace_admin(p_workspace_id,p_actor)) THEN RAISE EXCEPTION 'You cannot edit this record' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('name','notes','lifecycle_stage','stage_id')) THEN RAISE EXCEPTION 'Unsupported CRM field' USING ERRCODE='22023'; END IF;
 v_table:='crm_'||p_kind;
 EXECUTE format('UPDATE %I SET name=coalesce($1->>''name'',name),notes=coalesce($1->>''notes'',notes) WHERE id=$2 AND workspace_id=$3',v_table) USING p_changes,p_record_id,p_workspace_id;
 IF p_kind='contacts' AND p_changes ? 'lifecycle_stage' THEN UPDATE crm_contacts SET lifecycle_stage=p_changes->>'lifecycle_stage' WHERE id=p_record_id; END IF;
 IF p_kind='deals' AND p_changes ? 'stage_id' THEN UPDATE crm_deals SET stage_id=(p_changes->>'stage_id')::uuid WHERE id=p_record_id; END IF;
 RETURN jsonb_build_object('record_id',p_record_id,'link','/crm/'||p_kind||'/'||p_record_id);
END $$;
REVOKE ALL ON FUNCTION crm_read_for(uuid,uuid,text,uuid),crm_update_for(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION crm_read_for(uuid,uuid,text,uuid),crm_update_for(uuid,uuid,text,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.agent_execute_proposal(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  p agent_action_proposals%ROWTYPE; v_run agent_runs%ROWTYPE; v_gaps jsonb; v_result jsonb; v_task uuid; v_item drive_items%ROWTYPE;
  v_msg uuid; v_assignee text; v_channel uuid; v_folder uuid; v_body text;
BEGIN
  SELECT * INTO p FROM agent_action_proposals WHERE id = p_id;
  SELECT * INTO v_run FROM agent_runs WHERE id = p.run_id;
  IF NOT user_is_workspace_member(p.workspace_id, p.requested_for) THEN
    RAISE EXCEPTION 'You are no longer a member of this workspace' USING ERRCODE = '42501';
  END IF;
  v_gaps := agent_audience_gaps(p.run_id, agent_action_audience(p.workspace_id, p.requested_for, p.action_type, p.arguments));
  IF jsonb_array_length(v_gaps) > 0 THEN
    RAISE EXCEPTION 'Some people who would see this cannot open its sources anymore' USING ERRCODE = '42501';
  END IF;

  IF p.action_type = 'create_task' THEN
    IF nullif(p.arguments ->> 'project_id', '') IS NOT NULL AND (
       get_project_workspace_id((p.arguments ->> 'project_id')::uuid) IS DISTINCT FROM p.workspace_id
       OR NOT is_project_editor((p.arguments ->> 'project_id')::uuid, p.requested_for)) THEN
      RAISE EXCEPTION 'You cannot add tasks to that project' USING ERRCODE = '42501';
    END IF;
    INSERT INTO tasks (workspace_id, title, description, priority, due_date, project_id, channel_id, message_id, created_by)
    VALUES (p.workspace_id, left(p.arguments ->> 'title', 300), p.arguments ->> 'description',
            coalesce(nullif(p.arguments ->> 'priority', ''), 'medium'), nullif(p.arguments ->> 'due_date', '')::timestamptz,
            nullif(p.arguments ->> 'project_id', '')::uuid,
            CASE WHEN user_is_channel_member(nullif(p.arguments ->> 'source_channel_id', '')::uuid, p.requested_for)
                 THEN nullif(p.arguments ->> 'source_channel_id', '')::uuid END,
            NULL, p.requested_for)
    RETURNING id INTO v_task;
    FOR v_assignee IN SELECT jsonb_array_elements_text(coalesce(p.arguments -> 'assignee_ids', '[]')) LOOP
      IF NOT user_is_workspace_member(p.workspace_id, v_assignee::uuid) THEN
        RAISE EXCEPTION 'An assignee is not a workspace member' USING ERRCODE = '42501';
      END IF;
      INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES (v_task, v_assignee::uuid, p.requested_for) ON CONFLICT DO NOTHING;
    END LOOP;
    INSERT INTO task_activity (task_id, user_id, action, details)
    VALUES (v_task, p.requested_for, 'created', jsonb_build_object('source', 'agent', 'run_id', p.run_id, 'proposal_id', p.id));
    v_result := jsonb_build_object('task_id', v_task, 'link', '/tasks/' || v_task);

  ELSIF p.action_type = 'save_document' THEN
    v_folder := nullif(p.arguments ->> 'folder_id', '')::uuid;
    IF v_folder IS NOT NULL AND (drive_role_rank(drive_role_for(v_folder, p.requested_for)) < 3
       OR NOT EXISTS (SELECT 1 FROM drive_items WHERE id = v_folder AND workspace_id = p.workspace_id AND kind = 'folder')) THEN
      RAISE EXCEPTION 'You need edit access to that folder' USING ERRCODE = '42501';
    END IF;
    v_body := coalesce(p.arguments ->> 'body', '');
    INSERT INTO drive_items (workspace_id, parent_id, kind, name, owner_id, created_by, updated_by, mime_type, origin, current_revision_no, size_bytes)
    VALUES (p.workspace_id, v_folder, 'document', coalesce(nullif(drive_clean_name(p.arguments ->> 'title'), ''), 'Untitled document'),
            p.requested_for, p.requested_for, p.requested_for, 'text/markdown', 'agent_output', 1, octet_length(v_body))
    RETURNING * INTO v_item;
    INSERT INTO drive_document_revisions (item_id, workspace_id, revision_no, title, body, created_by, source)
    VALUES (v_item.id, p.workspace_id, 1, v_item.name, v_body, p.requested_for, 'agent_output');
    PERFORM knowledge_enqueue_source(v_item.id, NULL, (SELECT id FROM drive_document_revisions WHERE item_id = v_item.id AND revision_no = 1));
    v_result := jsonb_build_object('item_id', v_item.id, 'link', '/drive/item/' || v_item.id);

  ELSIF p.action_type = 'post_message' THEN
    v_channel := (p.arguments ->> 'channel_id')::uuid;
    IF NOT user_is_channel_member(v_channel, p.requested_for) THEN
      RAISE EXCEPTION 'You are no longer a member of that conversation' USING ERRCODE = '42501';
    END IF;
    IF nullif(p.arguments ->> 'parent_id', '') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM messages WHERE id = (p.arguments ->> 'parent_id')::uuid AND channel_id = v_channel AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'The thread no longer exists' USING ERRCODE = '22023';
    END IF;
    INSERT INTO messages (channel_id, user_id, content, parent_id, agent_id, agent_run_id)
    VALUES (v_channel, p.requested_for, left(p.arguments ->> 'content', 20000), nullif(p.arguments ->> 'parent_id', '')::uuid,
            v_run.agent_id, p.run_id)
    RETURNING id INTO v_msg;
    v_result := jsonb_build_object('message_id', v_msg, 'channel_id', v_channel);

  ELSIF p.action_type = 'update_crm_record' THEN
    v_result := crm_update_for(p.requested_for,p.workspace_id,p.arguments->>'kind',(p.arguments->>'record_id')::uuid,p.arguments->'changes');
  ELSE
    RAISE EXCEPTION 'Unsupported action %', p.action_type USING ERRCODE = '22023';
  END IF;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.agent_save_config(p_agent_id uuid, p_config jsonb)
RETURNS workspace_agent_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_agent workspace_agents%ROWTYPE; v_cur workspace_agent_versions%ROWTYPE; v_new workspace_agent_versions%ROWTYPE;
  v_settings workspace_ai_settings%ROWTYPE; v_tools text[]; v_scope jsonb; v_model text; v_item text;
BEGIN
  SELECT * INTO v_agent FROM workspace_agents WHERE id = p_agent_id;
  IF v_agent.id IS NULL OR NOT can_configure_agent(p_agent_id, auth.uid()) THEN
    RAISE EXCEPTION 'You cannot configure this agent' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cur FROM workspace_agent_versions WHERE id = v_agent.current_version_id;
  v_settings := ai_settings_for(v_agent.workspace_id);
  v_tools := CASE WHEN p_config ? 'tools' THEN ARRAY(SELECT jsonb_array_elements_text(p_config -> 'tools')) ELSE v_cur.tools END;
  IF EXISTS (SELECT 1 FROM unnest(v_tools) t WHERE NOT t = ANY(agent_known_tools())) THEN
    RAISE EXCEPTION 'Unknown tool in configuration' USING ERRCODE = '22023';
  END IF;
  v_model := coalesce(p_config ->> 'model', v_cur.model);
  IF NOT v_model = ANY(v_settings.allowed_models) THEN
    RAISE EXCEPTION 'Model % is not allowed in this workspace', v_model USING ERRCODE = '22023';
  END IF;
  v_scope := coalesce(p_config -> 'source_scope', v_cur.source_scope);
  IF v_scope ->> 'mode' NOT IN ('requester_access', 'selected') THEN
    RAISE EXCEPTION 'Invalid source scope' USING ERRCODE = '22023';
  END IF;
  -- Selected sources must be in this workspace and visible to the editor.
  FOR v_item IN SELECT jsonb_array_elements_text(coalesce(v_scope -> 'item_ids', '[]'::jsonb)) LOOP
    IF NOT EXISTS (SELECT 1 FROM drive_items WHERE id = v_item::uuid AND workspace_id = v_agent.workspace_id)
       OR NOT drive_can_view(v_item::uuid, auth.uid()) THEN
      RAISE EXCEPTION 'A selected source is not available' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  INSERT INTO workspace_agent_versions (agent_id, workspace_id, version_no, instructions, tools, source_scope, model, effort, max_tool_steps, created_by)
  VALUES (p_agent_id, v_agent.workspace_id, coalesce(v_cur.version_no, 0) + 1,
          coalesce(p_config ->> 'instructions', v_cur.instructions), v_tools, v_scope, v_model,
          coalesce(p_config ->> 'effort', v_cur.effort, 'medium'),
          coalesce((p_config ->> 'max_tool_steps')::integer, v_cur.max_tool_steps, 8), auth.uid())
  RETURNING * INTO v_new;
  UPDATE workspace_agents SET current_version_id = v_new.id,
    name = coalesce(nullif(btrim(p_config ->> 'name'), ''), name),
    description = coalesce(p_config ->> 'description', description),
    visibility = CASE WHEN is_builtin THEN visibility ELSE coalesce(p_config ->> 'visibility', visibility) END,
    updated_at = now()
  WHERE id = p_agent_id;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (v_agent.workspace_id, auth.uid(), 'agent_config_changed', 'agent', p_agent_id,
          jsonb_build_object('version_no', v_new.version_no, 'model', v_new.model, 'tools', v_new.tools));
  RETURN v_new;
END $$;
NOTIFY pgrst,'reload schema';
