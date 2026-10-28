-- Let Scout and the whole-team coordinator answer questions about CRM timeline
-- comments without enumerating every company. The worker passes the verified
-- requester identity; this function enforces workspace membership itself.

CREATE INDEX IF NOT EXISTS crm_notes_workspace_author_created
  ON public.crm_notes (workspace_id, author_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.crm_search_notes_for(
  p_actor uuid,
  p_workspace_id uuid,
  p_query text DEFAULT NULL,
  p_author text DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS TABLE(
  note_id uuid,
  record_id uuid,
  kind text,
  record_name text,
  body text,
  author_name text,
  author_username text,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT public.user_is_workspace_member(p_workspace_id, p_actor) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('contacts', 'companies', 'deals') THEN
    RAISE EXCEPTION 'Unknown CRM record kind' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH records AS (
    SELECT company.id, 'companies'::text AS kind, company.name
    FROM public.crm_companies company
    WHERE company.workspace_id = p_workspace_id
    UNION ALL
    SELECT contact.id, 'contacts', contact.name
    FROM public.crm_contacts contact
    WHERE contact.workspace_id = p_workspace_id
    UNION ALL
    SELECT deal.id, 'deals', deal.name
    FROM public.crm_deals deal
    WHERE deal.workspace_id = p_workspace_id
  )
  SELECT note.id, note.record_id, record.kind, record.name, note.body,
         coalesce(profile.display_name, profile.username, split_part(profile.email, '@', 1), 'Workspace member'),
         profile.username, note.created_at
  FROM public.crm_notes note
  JOIN records record ON record.id = note.record_id AND 'crm_' || record.kind = note.record_type
  LEFT JOIN public.profiles profile ON profile.id = note.author_id
  WHERE note.workspace_id = p_workspace_id
    AND (p_kind IS NULL OR record.kind = p_kind)
    AND (p_since IS NULL OR note.created_at >= p_since)
    AND (nullif(btrim(p_query), '') IS NULL OR note.body ILIKE '%' || btrim(p_query) || '%')
    AND (
      nullif(btrim(p_author), '') IS NULL
      OR lower(coalesce(profile.username, '')) = lower(btrim(p_author))
      OR lower(coalesce(profile.display_name, '')) = lower(btrim(p_author))
      OR lower(split_part(coalesce(profile.email, ''), '@', 1)) = lower(btrim(p_author))
    )
  ORDER BY note.created_at DESC, note.id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100);
END $$;

REVOKE ALL ON FUNCTION public.crm_search_notes_for(uuid, uuid, text, text, timestamptz, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_search_notes_for(uuid, uuid, text, text, timestamptz, text, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.agent_known_tools()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_conversation', 'list_tasks',
               'search_crm', 'search_crm_notes', 'read_crm_record', 'compute_csv_metrics', 'list_drive', 'web_search',
               'propose_task', 'propose_document', 'propose_drive_action', 'propose_channel_message', 'propose_crm_update',
               'read_calendar', 'propose_calendar_event', 'workspace_metrics', 'read_brand_kit', 'fetch_site_page',
               'read_personal_notes', 'save_personal_note', 'delegate_to_specialists', 'submit_tasks_for_approval'];
$$;

UPDATE public.agent_templates
SET default_tools = array_append(default_tools, 'search_crm_notes'),
    instructions = replace(
      instructions,
      'Route CRM questions through search_crm and read_crm_record;',
      'Route CRM record questions through search_crm and read_crm_record; use search_crm_notes for timeline comments, authors and dates;'
    )
WHERE key = 'agno_scout'
  AND NOT ('search_crm_notes' = ANY(default_tools));

DO $$
DECLARE scout record; next_version uuid; next_instructions text;
BEGIN
  SELECT instructions INTO next_instructions FROM public.agent_templates WHERE key = 'agno_scout';
  FOR scout IN
    SELECT agent.id, agent.workspace_id, version.version_no, version.instructions,
           version.tools, version.source_scope, version.model, version.effort,
           version.max_tool_steps, version.created_by
    FROM public.workspace_agents agent
    JOIN public.workspace_agent_versions version ON version.id = agent.current_version_id
    WHERE agent.template_key = 'agno_scout'
      AND agent.status = 'active' AND agent.archived_at IS NULL
      AND NOT ('search_crm_notes' = ANY(version.tools))
  LOOP
    INSERT INTO public.workspace_agent_versions (
      agent_id, workspace_id, version_no, instructions, tools, source_scope,
      model, effort, max_tool_steps, created_by
    ) VALUES (
      scout.id, scout.workspace_id, scout.version_no + 1,
      coalesce(next_instructions, scout.instructions),
      array_append(scout.tools, 'search_crm_notes'), scout.source_scope,
      scout.model, scout.effort, scout.max_tool_steps, scout.created_by
    ) RETURNING id INTO next_version;
    UPDATE public.workspace_agents
    SET current_version_id = next_version, updated_at = now()
    WHERE id = scout.id;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
