-- Make agent readiness claims match real runtime capabilities and let the
-- Social Calendar create reviewable drafts in the native Social area.

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_status_check
  CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled')) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_status_check;

ALTER TABLE public.workspace_connectors DROP CONSTRAINT IF EXISTS workspace_connectors_kind_check;
ALTER TABLE public.workspace_connectors ADD CONSTRAINT workspace_connectors_kind_check
  CHECK (kind IN ('support_inbox', 'commerce_store', 'email_platform', 'recruiting', 'search_analytics',
                  'social_accounts', 'email_inbox', 'accounting', 'product_analytics', 'billing', 'design_platform')) NOT VALID;
ALTER TABLE public.workspace_connectors VALIDATE CONSTRAINT workspace_connectors_kind_check;

ALTER TABLE public.agent_action_proposals DROP CONSTRAINT IF EXISTS agent_action_proposals_action_type_check;
ALTER TABLE public.agent_action_proposals ADD CONSTRAINT agent_action_proposals_action_type_check
  CHECK (action_type IN ('create_task', 'save_document', 'post_message', 'update_crm_record', 'create_event',
                         'create_drive_folder', 'rename_drive_item', 'move_drive_item', 'create_social_drafts')) NOT VALID;
ALTER TABLE public.agent_action_proposals VALIDATE CONSTRAINT agent_action_proposals_action_type_check;

ALTER FUNCTION public.agent_execute_proposal(uuid) RENAME TO agent_execute_proposal_pre_social;
REVOKE EXECUTE ON FUNCTION public.agent_execute_proposal_pre_social(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.agent_execute_proposal(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  proposal public.agent_action_proposals%ROWTYPE;
  post jsonb;
  post_id uuid;
  post_ids uuid[] := '{}';
  company_id uuid;
  body text;
BEGIN
  SELECT * INTO proposal FROM public.agent_action_proposals WHERE id = p_id;
  IF proposal.id IS NULL THEN RAISE EXCEPTION 'Proposal not found' USING ERRCODE = '22023'; END IF;
  IF proposal.action_type <> 'create_social_drafts' THEN
    RETURN public.agent_execute_proposal_pre_social(p_id);
  END IF;
  IF NOT public.user_is_workspace_member(proposal.workspace_id, proposal.requested_for)
     OR NOT public.feature_visible_to(proposal.workspace_id, proposal.requested_for, 'social') THEN
    RAISE EXCEPTION 'Social is no longer available to the requester' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(proposal.arguments -> 'posts') <> 'array'
     OR jsonb_array_length(proposal.arguments -> 'posts') NOT BETWEEN 1 AND 31 THEN
    RAISE EXCEPTION 'Provide between 1 and 31 Social drafts' USING ERRCODE = '22023';
  END IF;

  FOR post IN SELECT value FROM jsonb_array_elements(proposal.arguments -> 'posts')
  LOOP
    body := btrim(coalesce(post ->> 'body', ''));
    IF length(body) NOT BETWEEN 1 AND 10000 THEN
      RAISE EXCEPTION 'Each Social draft needs 1 to 10000 characters' USING ERRCODE = '22023';
    END IF;
    company_id := nullif(post ->> 'company_id', '')::uuid;
    IF company_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.crm_companies
      WHERE id = company_id AND workspace_id = proposal.workspace_id AND client_id IS NULL
    ) THEN
      RAISE EXCEPTION 'A Social draft references a company outside this workspace' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.social_posts (
      workspace_id, company_id, body, link, scheduled_at, status, created_by
    ) VALUES (
      proposal.workspace_id,
      company_id,
      body,
      nullif(btrim(coalesce(post ->> 'link', '')), ''),
      nullif(post ->> 'scheduled_at', '')::timestamptz,
      'draft',
      proposal.requested_for
    ) RETURNING id INTO post_id;
    post_ids := array_append(post_ids, post_id);
    INSERT INTO public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (proposal.workspace_id, proposal.requested_for, 'create_social_draft', 'social_post', post_id,
            jsonb_build_object('source', 'agent', 'proposal_id', proposal.id));
  END LOOP;
  RETURN jsonb_build_object('post_ids', to_jsonb(post_ids), 'link', '/social');
END $$;

REVOKE ALL ON FUNCTION public.agent_execute_proposal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_execute_proposal(uuid), public.agent_execute_proposal_pre_social(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.agent_known_tools()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_conversation', 'list_tasks',
               'search_crm', 'search_crm_notes', 'read_crm_record', 'compute_csv_metrics', 'list_drive', 'web_search',
               'propose_task', 'propose_document', 'propose_drive_action', 'propose_social_posts',
               'propose_channel_message', 'propose_crm_update', 'read_calendar', 'propose_calendar_event',
               'workspace_metrics', 'read_brand_kit', 'fetch_site_page', 'read_personal_notes',
               'save_personal_note', 'delegate_to_specialists', 'submit_tasks_for_approval'];
$$;

UPDATE public.agent_templates
SET default_tools = array_append(default_tools, 'propose_social_posts'),
    instructions = replace(
      instructions,
      'Use propose_document to save the calendar only after presenting it for review. You do not publish or schedule posts; those actions remain in the Social area and require explicit user approval.',
      'After presenting the calendar, use propose_social_posts when the requester wants dated drafts in the Social area. The review card creates drafts only; publishing and scheduling still require an explicit choice in Social. Use propose_document only when the requester also wants a Drive copy.'
    )
WHERE key = 'github_social_calendar'
  AND NOT ('propose_social_posts' = ANY(default_tools));

UPDATE public.agent_templates SET connectors = ARRAY['search_analytics'] WHERE key = 'github_marketing_strategy';
UPDATE public.agent_templates SET connectors = ARRAY['design_platform'] WHERE key = 'github_creative_direction';
UPDATE public.agent_templates SET connectors = ARRAY['accounting'] WHERE key = 'github_finance_analyst';
UPDATE public.agent_templates SET connectors = ARRAY['support_inbox', 'product_analytics', 'billing'] WHERE key = 'github_customer_success';

UPDATE public.agent_templates
SET default_tools = array_append(default_tools, 'web_search'),
    capability = 'Finds and synthesizes permitted workspace and current public evidence with explicit citations.',
    description = 'Researches permitted workspace sources and the public web when the runtime health check is available.',
    instructions = replace(instructions,
      'Search permitted workspace sources before drawing conclusions.',
      'Search permitted workspace sources first, then use web_search for current public evidence when useful.')
WHERE key = 'cerebras_research' AND NOT ('web_search' = ANY(default_tools));

UPDATE public.agent_templates
SET default_tools = array_append(array_append(default_tools, 'search_crm'), 'search_crm_notes'),
    capability = 'Computes defensible metrics from permitted CSV and Excel files, workspace aggregates and scoped CRM evidence.',
    description = 'Calculates spreadsheet and workspace metrics and can retrieve permitted CRM records and comments for analysis.'
WHERE key = 'cerebras_analyst' AND NOT ('search_crm' = ANY(default_tools));

DO $$
DECLARE agent record; next_version uuid; next_instructions text;
BEGIN
  SELECT instructions INTO next_instructions FROM public.agent_templates WHERE key = 'github_social_calendar';
  FOR agent IN
    SELECT workspace_agent.id, workspace_agent.workspace_id, version.version_no, version.instructions,
           version.tools, version.source_scope, version.model, version.effort,
           version.max_tool_steps, version.created_by
    FROM public.workspace_agents workspace_agent
    JOIN public.workspace_agent_versions version ON version.id = workspace_agent.current_version_id
    WHERE workspace_agent.template_key = 'github_social_calendar'
      AND workspace_agent.status = 'active' AND workspace_agent.archived_at IS NULL
      AND NOT ('propose_social_posts' = ANY(version.tools))
  LOOP
    INSERT INTO public.workspace_agent_versions (
      agent_id, workspace_id, version_no, instructions, tools, source_scope,
      model, effort, max_tool_steps, created_by
    ) VALUES (
      agent.id, agent.workspace_id, agent.version_no + 1,
      coalesce(next_instructions, agent.instructions), array_append(agent.tools, 'propose_social_posts'),
      agent.source_scope, agent.model, agent.effort, agent.max_tool_steps, agent.created_by
    ) RETURNING id INTO next_version;
    UPDATE public.workspace_agents SET current_version_id = next_version, updated_at = now() WHERE id = agent.id;
  END LOOP;
END $$;

DO $$
DECLARE agent record; next_version uuid; template record; next_tools text[];
BEGIN
  FOR agent IN
    SELECT workspace_agent.id, workspace_agent.workspace_id, workspace_agent.template_key,
           version.version_no, version.instructions, version.tools, version.source_scope,
           version.model, version.effort, version.max_tool_steps, version.created_by
    FROM public.workspace_agents workspace_agent
    JOIN public.workspace_agent_versions version ON version.id = workspace_agent.current_version_id
    WHERE workspace_agent.template_key IN ('cerebras_research', 'cerebras_analyst')
      AND workspace_agent.status = 'active' AND workspace_agent.archived_at IS NULL
  LOOP
    SELECT instructions, default_tools, description INTO template
    FROM public.agent_templates WHERE key = agent.template_key;
    next_tools := agent.tools;
    IF agent.template_key = 'cerebras_research' AND NOT ('web_search' = ANY(next_tools)) THEN
      next_tools := array_append(next_tools, 'web_search');
    ELSIF agent.template_key = 'cerebras_analyst' AND NOT ('search_crm' = ANY(next_tools)) THEN
      next_tools := array_append(array_append(next_tools, 'search_crm'), 'search_crm_notes');
    ELSE
      CONTINUE;
    END IF;
    INSERT INTO public.workspace_agent_versions (
      agent_id, workspace_id, version_no, instructions, tools, source_scope,
      model, effort, max_tool_steps, created_by
    ) VALUES (
      agent.id, agent.workspace_id, agent.version_no + 1, template.instructions, next_tools,
      agent.source_scope, agent.model, agent.effort, agent.max_tool_steps, agent.created_by
    ) RETURNING id INTO next_version;
    UPDATE public.workspace_agents
    SET current_version_id = next_version, description = template.description, updated_at = now()
    WHERE id = agent.id;
  END LOOP;
END $$;

-- The audit identified that web-capable agents were installed with web
-- research disabled. This enables the workspace switch; runtime health still
-- determines whether cards say Ready or Partially ready.
UPDATE public.workspace_ai_settings SET web_research_enabled = true WHERE NOT web_research_enabled;

-- A reviewed draft enters the existing publishing flow only when the person
-- chooses accounts and schedules it in Social.
CREATE OR REPLACE FUNCTION public.social_schedule_post(
  p_workspace_id uuid, p_company_id uuid, p_body text, p_link text, p_account_ids uuid[],
  p_scheduled_at timestamptz DEFAULT NULL, p_post_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_post uuid := p_post_id; v_target record; v_run timestamptz := greatest(coalesce(p_scheduled_at, now()), now());
BEGIN
  IF v_uid IS NULL OR NOT user_is_workspace_member(p_workspace_id, v_uid) OR NOT feature_visible_to(p_workspace_id, v_uid, 'social') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF cardinality(coalesce(p_account_ids, '{}')) = 0 THEN RAISE EXCEPTION 'Choose at least one account' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_account_ids) a(id) LEFT JOIN social_accounts s ON s.id = a.id
              WHERE s.id IS NULL OR s.workspace_id <> p_workspace_id OR s.company_id IS DISTINCT FROM p_company_id) THEN
    RAISE EXCEPTION 'Choose accounts of this company' USING ERRCODE = '22023';
  END IF;
  IF v_post IS NULL THEN
    INSERT INTO social_posts (workspace_id, company_id, body, link, scheduled_at, created_by)
    VALUES (p_workspace_id, p_company_id, btrim(p_body), nullif(btrim(coalesce(p_link, '')), ''), p_scheduled_at, v_uid)
    RETURNING id INTO v_post;
  ELSE
    UPDATE social_posts SET body = btrim(p_body), link = nullif(btrim(coalesce(p_link, '')), ''),
      scheduled_at = p_scheduled_at, status = 'scheduled', updated_at = now()
     WHERE id = v_post AND workspace_id = p_workspace_id AND company_id IS NOT DISTINCT FROM p_company_id
       AND status IN ('draft', 'scheduled', 'failed', 'partial', 'cancelled')
       AND (created_by = v_uid OR user_is_workspace_admin(p_workspace_id, v_uid));
    IF NOT FOUND THEN RAISE EXCEPTION 'This post can no longer be changed' USING ERRCODE = '42501'; END IF;
    DELETE FROM social_post_targets WHERE post_id = v_post AND status <> 'published' AND NOT (account_id = ANY(p_account_ids));
  END IF;
  INSERT INTO social_post_targets (workspace_id, post_id, account_id)
  SELECT p_workspace_id, v_post, a FROM unnest(p_account_ids) a
  ON CONFLICT (post_id, account_id) DO UPDATE SET
    status = CASE WHEN social_post_targets.status = 'published' THEN 'published' ELSE 'pending' END, error = NULL;
  FOR v_target IN SELECT id FROM social_post_targets WHERE post_id = v_post AND status = 'pending' LOOP
    PERFORM enqueue_job('social.publish', p_workspace_id, v_uid,
      jsonb_build_object('target_id', v_target.id, 'run_at', v_run),
      'social:' || v_target.id || ':' || extract(epoch FROM v_run)::bigint || ':' || extract(epoch FROM clock_timestamp())::bigint,
      v_run, 2);
  END LOOP;
  RETURN v_post;
END $$;

NOTIFY pgrst, 'reload schema';
