-- ============================================================================
-- 20261119000100_crm_report_agent_tool.sql
-- ----------------------------------------------------------------------------
-- Agents could only list CRM records (search_crm, capped at 50, without each
-- contact's company), so questions like "how many companies have a contact"
-- went unanswered. crm_report gives exact counts and breakdowns for one CRM
-- (ours or a managed company's) through a fixed, allow-listed query: no
-- caller-supplied SQL, and the same workspace/managed-company checks as the
-- other CRM context functions.
--
-- Also: contact search results now name the contact's company.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.crm_report_for_context(
  p_actor uuid, p_workspace_id uuid, p_client_id uuid,
  p_entity text, p_group_by text DEFAULT NULL, p_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_summary jsonb;
  v_groups jsonb := NULL;
  v_group_count integer := NULL;
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_client_id);
  IF p_entity NOT IN ('contacts', 'companies', 'deals') THEN
    RAISE EXCEPTION 'Report on contacts, companies or deals' USING ERRCODE = '22023';
  END IF;
  IF p_group_by IS NOT NULL AND NOT (
       (p_entity = 'contacts' AND p_group_by IN ('company', 'lifecycle_stage', 'owner', 'email_status', 'has_email', 'location', 'title'))
    OR (p_entity = 'companies' AND p_group_by IN ('contacts_per_company', 'has_contacts', 'industry', 'prospect_type', 'contact_status', 'listed_location', 'owner'))
    OR (p_entity = 'deals' AND p_group_by IN ('stage', 'company', 'owner', 'currency'))
  ) THEN
    RAISE EXCEPTION 'Cannot group % by %', p_entity, p_group_by USING ERRCODE = '22023';
  END IF;

  IF p_entity = 'contacts' THEN
    SELECT jsonb_build_object(
      'contacts', count(*),
      'linked_to_a_company', count(c.company_id),
      'not_linked_to_a_company', count(*) - count(c.company_id),
      'distinct_companies_with_contacts', count(DISTINCT c.company_id),
      'with_email', count(c.email),
      'without_email', count(*) - count(c.email),
      'with_phone', count(nullif(c.phone, '')))
    INTO v_summary
    FROM public.crm_contacts c
    WHERE c.workspace_id = p_workspace_id AND c.client_id IS NOT DISTINCT FROM p_client_id;

    IF p_group_by IS NOT NULL THEN
      WITH g AS (
        SELECT CASE p_group_by WHEN 'company' THEN c.company_id WHEN 'owner' THEN c.owner_id END AS id,
               CASE p_group_by
                 WHEN 'company' THEN coalesce(co.name, '(no company)')
                 WHEN 'owner' THEN coalesce(nullif(p.display_name, ''), p.username, '(unknown)')
                 WHEN 'lifecycle_stage' THEN coalesce(nullif(c.lifecycle_stage, ''), '(not set)')
                 WHEN 'email_status' THEN coalesce(nullif(c.custom ->> 'email_status', ''), '(not set)')
                 WHEN 'has_email' THEN CASE WHEN c.email IS NULL THEN 'no email' ELSE 'has email' END
                 WHEN 'location' THEN coalesce(nullif(c.custom ->> 'location', ''), '(not set)')
                 WHEN 'title' THEN coalesce(nullif(btrim(c.title), ''), '(not set)')
               END AS label,
               count(*) AS n
        FROM public.crm_contacts c
        LEFT JOIN public.crm_companies co ON co.id = c.company_id
        LEFT JOIN public.profiles p ON p.id = c.owner_id
        WHERE c.workspace_id = p_workspace_id AND c.client_id IS NOT DISTINCT FROM p_client_id
        GROUP BY 1, 2
      )
      SELECT (SELECT count(*) FROM g),
             (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'label', label, 'count', n)) ORDER BY n DESC, label), '[]')
                FROM (SELECT * FROM g ORDER BY n DESC, label LIMIT v_limit) top)
      INTO v_group_count, v_groups;
    END IF;

  ELSIF p_entity = 'companies' THEN
    WITH co AS (
      SELECT c.*,
             (SELECT count(*) FROM public.crm_contacts x WHERE x.company_id = c.id) AS contact_count,
             (SELECT count(*) FROM public.crm_deals d WHERE d.company_id = c.id) AS deal_count
      FROM public.crm_companies c
      WHERE c.workspace_id = p_workspace_id AND c.client_id IS NOT DISTINCT FROM p_client_id
    )
    SELECT jsonb_build_object(
      'companies', count(*),
      'with_at_least_one_contact', count(*) FILTER (WHERE contact_count > 0),
      'without_contacts', count(*) FILTER (WHERE contact_count = 0),
      'contacts_linked_to_these_companies', coalesce(sum(contact_count), 0),
      'with_at_least_one_deal', count(*) FILTER (WHERE deal_count > 0),
      'with_email', count(nullif(email, '')),
      'with_phone', count(nullif(phone, '')),
      'with_website', count(nullif(domain, '')))
    INTO v_summary FROM co;

    IF p_group_by IS NOT NULL THEN
      WITH co AS (
        SELECT c.*, (SELECT count(*) FROM public.crm_contacts x WHERE x.company_id = c.id) AS contact_count
        FROM public.crm_companies c
        WHERE c.workspace_id = p_workspace_id AND c.client_id IS NOT DISTINCT FROM p_client_id
      ), g AS (
        SELECT CASE p_group_by WHEN 'contacts_per_company' THEN co.id WHEN 'owner' THEN co.owner_id END AS id,
               CASE p_group_by
                 WHEN 'contacts_per_company' THEN co.name
                 WHEN 'has_contacts' THEN CASE WHEN co.contact_count > 0 THEN 'has contacts' ELSE 'no contacts' END
                 WHEN 'industry' THEN coalesce(nullif(co.industry, ''), '(not set)')
                 WHEN 'prospect_type' THEN coalesce(nullif(co.prospect_type, ''), '(not set)')
                 WHEN 'contact_status' THEN coalesce(nullif(co.contact_status, ''), '(not set)')
                 WHEN 'listed_location' THEN coalesce(nullif(co.listed_location, ''), '(not set)')
                 WHEN 'owner' THEN coalesce(nullif(p.display_name, ''), p.username, '(unknown)')
               END AS label,
               CASE WHEN p_group_by = 'contacts_per_company' THEN max(co.contact_count) ELSE count(*) END AS n
        FROM co LEFT JOIN public.profiles p ON p.id = co.owner_id
        GROUP BY 1, 2
      )
      SELECT (SELECT count(*) FROM g),
             (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'label', label, 'count', n)) ORDER BY n DESC, label), '[]')
                FROM (SELECT * FROM g ORDER BY n DESC, label LIMIT v_limit) top)
      INTO v_group_count, v_groups;
    END IF;

  ELSE
    SELECT jsonb_build_object(
      'deals', (SELECT count(*) FROM public.crm_deals d WHERE d.workspace_id = p_workspace_id AND d.client_id IS NOT DISTINCT FROM p_client_id),
      'value_by_currency', (
        SELECT coalesce(jsonb_object_agg(currency, total), '{}') FROM (
          SELECT d.currency, sum(d.value) AS total FROM public.crm_deals d
          WHERE d.workspace_id = p_workspace_id AND d.client_id IS NOT DISTINCT FROM p_client_id
          GROUP BY d.currency) v))
    INTO v_summary;

    IF p_group_by IS NOT NULL THEN
      WITH base AS (
        SELECT CASE p_group_by WHEN 'stage' THEN d.stage_id WHEN 'company' THEN d.company_id WHEN 'owner' THEN d.owner_id END AS id,
               CASE p_group_by
                 WHEN 'stage' THEN coalesce(st.name, '(unknown stage)')
                 WHEN 'company' THEN coalesce(co.name, '(no company)')
                 WHEN 'owner' THEN coalesce(nullif(p.display_name, ''), p.username, '(unknown)')
                 WHEN 'currency' THEN d.currency
               END AS label,
               d.currency, d.value
        FROM public.crm_deals d
        LEFT JOIN public.crm_stages st ON st.id = d.stage_id
        LEFT JOIN public.crm_companies co ON co.id = d.company_id
        LEFT JOIN public.profiles p ON p.id = d.owner_id
        WHERE d.workspace_id = p_workspace_id AND d.client_id IS NOT DISTINCT FROM p_client_id
      ), by_currency AS (
        SELECT id, label, currency, count(*) AS n, sum(value) AS total FROM base GROUP BY 1, 2, 3
      ), g AS (
        SELECT id, label, sum(n) AS n, jsonb_object_agg(currency, total) AS value_by_currency FROM by_currency GROUP BY 1, 2
      )
      SELECT (SELECT count(*) FROM g),
             (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'label', label, 'count', n, 'value_by_currency', value_by_currency)) ORDER BY n DESC, label), '[]')
                FROM (SELECT * FROM g ORDER BY n DESC, label LIMIT v_limit) top)
      INTO v_group_count, v_groups;
    END IF;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'crm', CASE WHEN p_client_id IS NULL THEN 'agency CRM' ELSE (SELECT name || '''s CRM' FROM public.crm_companies WHERE id = p_client_id) END,
    'entity', p_entity,
    'summary', v_summary,
    'group_by', p_group_by,
    'group_count', v_group_count,
    'groups', v_groups,
    'groups_truncated', CASE WHEN v_group_count IS NOT NULL THEN v_group_count > v_limit END,
    'generated_at', now()));
END $$;

REVOKE ALL ON FUNCTION public.crm_report_for_context(uuid, uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_report_for_context(uuid, uuid, uuid, text, text, integer) TO service_role;

-- Contact search results name the contact's company.
CREATE OR REPLACE FUNCTION public.crm_search_for_context(
  p_actor uuid, p_workspace_id uuid, p_client_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL, p_kind text DEFAULT NULL, p_limit integer DEFAULT 20
) RETURNS TABLE(id uuid, kind text, name text, detail text, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_client_id);
  IF p_kind IS NOT NULL AND p_kind NOT IN ('contacts', 'companies', 'deals') THEN
    RAISE EXCEPTION 'Unknown CRM record kind' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH records AS (
    SELECT c.id, 'contacts'::text AS kind, c.name,
      concat_ws(' · ', nullif(c.title, ''), CASE WHEN co.id IS NOT NULL THEN 'company: ' || co.name || ' (' || co.id || ')' END,
                nullif(c.email, ''), nullif(c.phone, ''), nullif(c.lifecycle_stage, ''), nullif(c.notes, '')) AS detail,
      c.updated_at
    FROM public.crm_contacts c
    LEFT JOIN public.crm_companies co ON co.id = c.company_id
    WHERE c.workspace_id = p_workspace_id AND c.client_id IS NOT DISTINCT FROM p_client_id
    UNION ALL
    SELECT c.id, 'companies', c.name,
      concat_ws(' · ', nullif(c.domain, ''), nullif(c.industry, ''), nullif(c.email, ''), nullif(c.phone, ''), nullif(c.notes, '')),
      c.updated_at
    FROM public.crm_companies c
    WHERE c.workspace_id = p_workspace_id
      AND (c.client_id IS NOT DISTINCT FROM p_client_id OR (p_client_id IS NOT NULL AND c.id = p_client_id))
    UNION ALL
    SELECT d.id, 'deals', d.name,
      concat_ws(' · ', d.value::text || ' ' || d.currency, nullif(d.expected_close::text, ''), nullif(d.notes, '')),
      d.updated_at
    FROM public.crm_deals d
    WHERE d.workspace_id = p_workspace_id AND d.client_id IS NOT DISTINCT FROM p_client_id
  )
  SELECT r.id, r.kind, r.name, r.detail, r.updated_at
  FROM records r
  WHERE (p_kind IS NULL OR r.kind = p_kind)
    AND (nullif(btrim(p_query), '') IS NULL OR lower(r.name || ' ' || r.detail) LIKE '%' || lower(btrim(p_query)) || '%')
  ORDER BY r.updated_at DESC, lower(r.name)
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 50);
END $$;
REVOKE ALL ON FUNCTION public.crm_search_for_context(uuid, uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_search_for_context(uuid, uuid, uuid, text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.agent_known_tools()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_conversation', 'list_tasks',
               'search_crm', 'search_crm_notes', 'read_crm_record', 'crm_report', 'compute_csv_metrics', 'list_drive',
               'web_search', 'browser_scrape', 'propose_task', 'propose_document', 'propose_drive_action',
               'propose_social_posts', 'propose_channel_message', 'propose_crm_update', 'read_calendar',
               'propose_calendar_event', 'workspace_metrics', 'read_brand_kit', 'fetch_site_page',
               'read_personal_notes', 'save_personal_note', 'delegate_to_specialists',
               'submit_tasks_for_approval'];
$$;

-- No agent versions change here: the engine gives crm_report to every run
-- whose agent can search the CRM, and to the team coordinator (see
-- server/agents/tools/index.ts companionTools). Admins can also add it
-- explicitly, hence the known-tools entry.

NOTIFY pgrst, 'reload schema';
