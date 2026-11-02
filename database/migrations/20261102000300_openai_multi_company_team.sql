-- Replace the visible built-in roster with an OpenAI-native business team and
-- make CRM tools respect the managed company selected on each run. Historical
-- agent versions, conversations, runs and audit evidence remain immutable.

CREATE OR REPLACE FUNCTION public.crm_validate_agent_client(
  p_actor uuid, p_workspace_id uuid, p_client_id uuid
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.user_is_workspace_member(p_workspace_id, p_actor) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.crm_companies
    WHERE id = p_client_id AND workspace_id = p_workspace_id
      AND is_client AND client_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Managed company not found' USING ERRCODE = '42501';
  END IF;
END $$;

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
      concat_ws(' · ', nullif(c.title, ''), nullif(c.email, ''), nullif(c.phone, ''), nullif(c.lifecycle_stage, ''), nullif(c.notes, '')) AS detail,
      c.updated_at
    FROM public.crm_contacts c
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

CREATE OR REPLACE FUNCTION public.crm_read_for_context(
  p_actor uuid, p_workspace_id uuid, p_client_id uuid,
  p_kind text, p_record_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v jsonb; v_book uuid;
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_client_id);
  v := public.crm_read_for(p_actor, p_workspace_id, p_kind, p_record_id);
  v_book := nullif(v ->> 'client_id', '')::uuid;
  IF p_client_id IS NULL AND v_book IS NOT NULL THEN
    RAISE EXCEPTION 'Record is outside the portfolio context' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NOT NULL
     AND v_book IS DISTINCT FROM p_client_id
     AND NOT (p_kind = 'companies' AND p_record_id = p_client_id) THEN
    RAISE EXCEPTION 'Record is outside the selected managed company' USING ERRCODE = '42501';
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.crm_search_notes_for_context(
  p_actor uuid, p_workspace_id uuid, p_client_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL, p_author text DEFAULT NULL,
  p_since timestamptz DEFAULT NULL, p_kind text DEFAULT NULL, p_limit integer DEFAULT 50
) RETURNS TABLE(
  note_id uuid, record_id uuid, kind text, record_name text, body text,
  author_name text, author_username text, created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_client_id);
  IF p_kind IS NOT NULL AND p_kind NOT IN ('contacts', 'companies', 'deals') THEN
    RAISE EXCEPTION 'Unknown CRM record kind' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH records AS (
    SELECT c.id, 'companies'::text AS kind, c.name
    FROM public.crm_companies c
    WHERE c.workspace_id = p_workspace_id
      AND (c.client_id IS NOT DISTINCT FROM p_client_id OR (p_client_id IS NOT NULL AND c.id = p_client_id))
    UNION ALL
    SELECT c.id, 'contacts', c.name FROM public.crm_contacts c
    WHERE c.workspace_id = p_workspace_id AND c.client_id IS NOT DISTINCT FROM p_client_id
    UNION ALL
    SELECT d.id, 'deals', d.name FROM public.crm_deals d
    WHERE d.workspace_id = p_workspace_id AND d.client_id IS NOT DISTINCT FROM p_client_id
  )
  SELECT n.id, n.record_id, r.kind, r.name, n.body,
         coalesce(p.display_name, p.username, split_part(p.email, '@', 1), 'Workspace member'),
         p.username, n.created_at
  FROM public.crm_notes n
  JOIN records r ON r.id = n.record_id AND 'crm_' || r.kind = n.record_type
  LEFT JOIN public.profiles p ON p.id = n.author_id
  WHERE n.workspace_id = p_workspace_id
    AND (p_kind IS NULL OR r.kind = p_kind)
    AND (p_since IS NULL OR n.created_at >= p_since)
    AND (nullif(btrim(p_query), '') IS NULL OR n.body ILIKE '%' || btrim(p_query) || '%')
    AND (nullif(btrim(p_author), '') IS NULL
      OR lower(coalesce(p.username, '')) = lower(btrim(p_author))
      OR lower(coalesce(p.display_name, '')) = lower(btrim(p_author))
      OR lower(split_part(coalesce(p.email, ''), '@', 1)) = lower(btrim(p_author)))
  ORDER BY n.created_at DESC, n.id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100);
END $$;

REVOKE ALL ON FUNCTION public.crm_validate_agent_client(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_search_for_context(uuid, uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_read_for_context(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_search_notes_for_context(uuid, uuid, uuid, text, text, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_validate_agent_client(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_search_for_context(uuid, uuid, uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_read_for_context(uuid, uuid, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_search_notes_for_context(uuid, uuid, uuid, text, text, timestamptz, text, integer) TO service_role;

CREATE TEMP TABLE _openai_company_team (
  key text PRIMARY KEY, name text, handle text, job text, capability text, category text, role_instruction text
) ON COMMIT DROP;

INSERT INTO _openai_company_team VALUES
('cerebras_coordinator','Company Portfolio Director','cerebras-team','Multi-company team coordinator','Routes work across the business team while keeping every client company separate.','Coordination','Own the final answer. Handle simple requests directly; for complex work select the relevant specialist workflow and synthesize one concise, evidence-grounded result.'),
('cerebras_research','Market Research Manager','cerebras-research','Market research specialist','Researches markets, audiences and opportunities using permitted internal and current public evidence.','Research','Build cited research briefs, distinguish evidence from inference, and identify unanswered questions.'),
('cerebras_analyst','Business Intelligence Analyst','cerebras-analyst','Business intelligence specialist','Analyzes company-specific exports and workspace metrics without mixing clients or currencies.','Analytics','Use calculation tools for every numeric claim, state filters and periods, and flag missing or incompatible data.'),
('cerebras_writer','Content Manager','cerebras-writer','Content and notes specialist','Creates source-grounded content, meeting notes and reviewed action items for the selected company.','Content','Draft in the selected company voice, preserve factual support, and turn decisions into reviewable follow-ups.'),
('agno_scout','CRM & Prospecting Manager','scout','CRM and prospecting specialist','Navigates the selected company CRM, researches prospects and prepares reviewed CRM follow-ups.','CRM & Sales','Search CRM evidence before making claims, use current public research when enabled, and never claim a CRM change occurred before approval.'),
('agno_drive_agent','Company Drive Manager','drive-agent','Drive operations specialist','Finds company files and prepares reviewed documents, folders, renames and moves.','Drive','Prefer the selected company folder, use exact file evidence, and keep every Drive mutation as a review card.'),
('github_social_calendar','Social Media Manager','social-calendar','Social media calendar specialist','Creates company-specific social calendars and reviewed post drafts.','Marketing','Build channel-specific calendars from the selected company brand and goals, then prepare dated Social drafts for approval.'),
('github_customer_support','Customer Support Manager','customer-support','Customer support specialist','Drafts evidence-grounded customer responses and support playbooks for the selected company.','Customers','Ground every answer in permitted product and policy sources, identify uncertainty, and never claim a message was sent.'),
('github_seo_specialist','SEO Manager','seo-specialist','SEO specialist','Audits the configured company site and creates prioritized SEO briefs.','Marketing','Separate observed site evidence from recommendations and never invent rankings, traffic or search-volume data.'),
('github_sales_development','Sales Development Manager','sales-development','Sales development specialist','Qualifies selected-company CRM prospects and drafts outreach and next-step plans.','CRM & Sales','Use CRM facts first, research public claims when useful, and prepare outreach and CRM changes only for review.'),
('github_recruiting','People Operations Manager','recruiting-assistant','People and recruiting specialist','Creates job posts, scorecards, interview plans and onboarding materials.','People','Use approved company sources, avoid protected-trait inference, and keep hiring decisions with people.'),
('github_marketing_strategy','Marketing Strategy Manager','marketing-strategist','Marketing strategy specialist','Builds evidence-grounded positioning, channel and campaign plans per company.','Marketing','Tie audiences, messages, channels and measurement to the selected company evidence and label assumptions.'),
('github_creative_direction','Creative Campaign Manager','creative-director','Creative direction specialist','Develops on-brand campaign concepts and production-ready creative briefs.','Marketing','Offer distinct concepts with audience, message, visual direction, formats and acceptance criteria grounded in the company brand.'),
('github_email_marketing','Email Marketing Manager','email-marketing','Email marketing specialist','Creates permission-aware email campaigns and sequences for review.','Marketing','Use opted-in audience assumptions only, avoid invented proof, and deliver subject, preview, body, CTA and measurement plans.'),
('github_commerce_analyst','Commerce Manager','commerce-analyst','Commerce specialist','Analyzes selected-company product and order exports and prepares merchandising reports.','Commerce','Name each source, filter, currency and period; never merge incompatible company or currency data.'),
('github_executive_assistant','Executive Operations Assistant','executive-assistant','Executive operations specialist','Creates company-aware briefings, meeting preparation and reviewed follow-ups.','Productivity','Prioritize what needs attention, keep client contexts separate, and distinguish proposed actions from completed work.'),
('github_project_manager','Project Delivery Manager','project-manager','Project delivery specialist','Turns company goals and decisions into reviewable delivery plans and task proposals.','Productivity','Define scope, deliverables, dependencies, risks, milestones and acceptance criteria without inventing owners or dates.'),
('github_finance_analyst','Finance Manager','finance-analyst','Finance analysis specialist','Builds source-grounded company finance summaries from permitted files and metrics.','Finance','Reconcile figures when possible, state currency and period, and never provide invented, personalized tax, legal or investment advice.'),
('github_competitor_intelligence','Competitive Intelligence Manager','competitor-intelligence','Competitive intelligence specialist','Creates cited competitor and market briefs for the selected company.','Strategy','Compare positioning, audience, offer, proof and channels using dated evidence; separate fact from inference.'),
('github_customer_success','Customer Success Manager','customer-success','Customer success specialist','Prepares company-specific account reviews, onboarding plans and renewal briefs from CRM evidence.','Customers','Ground health, risk and next steps in CRM and delivery evidence and never invent sentiment or scores.');

UPDATE public.agent_templates t
SET name = m.name, handle = m.handle, job = m.job, capability = m.capability,
    category = m.category,
    description = m.capability,
    instructions = 'You work in a multi-company management workspace. The run context identifies either one managed company or portfolio view. For company-specific CRM, Drive, content, campaign, social or reporting work, require a selected company and never mix one company''s records, files, brand, customers or metrics with another''s. Portfolio comparisons are allowed only when explicitly requested and must label every company and source. Use only tools and sources available to the requester. Every mutation remains a proposal until the requester approves it.\n\nYour workflow: ' || m.role_instruction,
    default_model = 'gpt-6.1-sol', retired = false
FROM _openai_company_team m
WHERE t.key = m.key;

-- Earlier roster replacements intentionally kept archived rows for audit and
-- old conversations. Release their handles before assigning the new team.
UPDATE public.workspace_agents wa
SET handle = 'archived-' || left(replace(wa.id::text, '-', ''), 24), updated_at = now()
FROM _openai_company_team m
WHERE wa.archived_at IS NOT NULL AND wa.handle = m.handle;

DO $$
DECLARE a record; v_next uuid;
BEGIN
  FOR a IN
    SELECT wa.id, wa.workspace_id, wav.version_no, wav.source_scope, wav.effort,
           wav.max_tool_steps, wav.created_by, t.instructions, t.default_tools,
           t.name, t.handle, t.job, t.capability, t.category
    FROM public.workspace_agents wa
    JOIN _openai_company_team m ON m.key = wa.template_key
    JOIN public.agent_templates t ON t.key = wa.template_key
    JOIN public.workspace_agent_versions wav ON wav.id = wa.current_version_id
    WHERE wa.is_builtin AND wa.archived_at IS NULL
  LOOP
    INSERT INTO public.workspace_agent_versions (
      agent_id, workspace_id, version_no, instructions, tools, source_scope,
      model, effort, max_tool_steps, created_by
    ) VALUES (
      a.id, a.workspace_id, a.version_no + 1, a.instructions, a.default_tools,
      a.source_scope, 'gpt-6.1-sol', a.effort, a.max_tool_steps, a.created_by
    ) RETURNING id INTO v_next;
    UPDATE public.workspace_agents
    SET name = a.name, handle = a.handle, description = a.capability,
        category = a.category, current_version_id = v_next, status = 'active', updated_at = now()
    WHERE id = a.id;
  END LOOP;
END $$;

UPDATE public.workspace_ai_settings
SET default_model = 'gpt-6.1-sol',
    allowed_models = CASE WHEN 'gpt-6.1-sol' = ANY(allowed_models) THEN allowed_models ELSE array_append(allowed_models, 'gpt-6.1-sol') END,
    updated_at = now();

NOTIFY pgrst, 'reload schema';
