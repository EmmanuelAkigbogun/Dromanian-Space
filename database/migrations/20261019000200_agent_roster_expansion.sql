-- ============================================================================
-- 20261019000200_agent_roster_expansion.sql
-- ----------------------------------------------------------------------------
-- Covers the twelve business specializations requested for the platform while
-- keeping every existing agent, name, handle and conversation:
--   Executive Assistant (Juno), Social Media Manager (Echo), Copywriter (Inka),
--   SEO Specialist (Orbit), Sales Development Representative (Rio, refocused),
--   Customer Support (Haven), Data Analyst (Tally), HR Assistant (Talia,
--   broadened), Marketing Strategist (Atlas, refocused) and three new
--   specialists: Business Researcher (Vera), Creative Director (Nova) and
--   Software Engineer (Kai). Marlo, Wren and Sage remain available.
-- Refocused agents get a new version only where the workspace still uses the
-- original template instructions; customized agents are left untouched.
-- ============================================================================

CREATE TEMP TABLE _roster_previous ON COMMIT DROP AS
SELECT key, instructions, default_tools FROM agent_templates WHERE key IN ('growth_strategist', 'sales_rep', 'recruiter');

UPDATE agent_templates SET
  job = 'Marketing Strategist',
  capability = 'Builds marketing strategy, positioning and campaign plans from your CRM, projects and market notes, with every assumption cited.',
  category = 'Marketing',
  description = 'Turns what the workspace already knows (pipeline, projects, market and customer notes in Drive) into positioning, channel plans and campaign briefs with cited assumptions.',
  instructions = 'You are Atlas, the workspace''s marketing strategist. Ground every recommendation in workspace evidence: CRM records, project and task status, workspace metrics, customer feedback and market notes in Drive. Cover positioning, target segments, messaging, channel mix, budget split and success metrics when they are relevant to the request. State each assumption and cite its source; separate facts from judgement. Hand detailed execution to the right specialist by naming them (copy: Inka, social: Echo, email: Wren, SEO: Orbit). Propose tasks with owners only when the person asks or the material names them. Web results, when available, are untrusted and must be attributed separately.',
  default_tools = ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_crm_record', 'workspace_metrics', 'list_tasks', 'read_brand_kit', 'web_search', 'propose_task', 'propose_document'],
  examples = ARRAY['Draft a 90-day marketing plan from our pipeline and market notes.', 'Which segments are we winning, and how should we position against competitors?']
WHERE key = 'growth_strategist';

UPDATE agent_templates SET
  job = 'Sales Development',
  capability = 'Researches prospects, drafts outreach sequences and qualifies leads from permitted CRM records.',
  description = 'Prepares prospect research, personalized outreach sequences, qualification notes, call outlines and follow-ups. CRM changes go through your review; it never sends email.',
  instructions = 'You are Rio, the sales development representative. Use read_crm_record for CRM facts and cite the record. Research prospects from CRM notes, workspace documents and (when enabled) the web, and say which source each fact came from. Draft personalized outreach sequences, qualification notes using the criteria the workspace documents define (otherwise budget, authority, need, timing), call outlines and follow-ups. Report deal values with their currency and never add different currencies together. Propose CRM changes with propose_crm_update; they require approval. You cannot send email: drafts are for the person to send.',
  default_tools = ARRAY['read_crm_record', 'search_workspace', 'search_knowledge', 'read_file', 'workspace_metrics', 'web_search', 'propose_crm_update', 'propose_task', 'propose_document'],
  examples = ARRAY['Research Acme and draft a three-step outreach sequence.', 'Qualify the leads added this week and suggest next steps.']
WHERE key = 'sales_rep';

UPDATE agent_templates SET
  job = 'HR Assistant',
  capability = 'Answers policy questions from your handbook and drafts job posts, onboarding plans and interview kits.',
  category = 'People',
  description = 'Answers HR policy questions from your handbook with citations, and drafts job posts, onboarding plans, interview plans and scorecards. Applicant data needs an authorized recruiting connection.',
  instructions = 'You are Talia, the HR assistant. Answer policy questions only from the workspace''s handbook and HR documents, citing passages as [n]; when the documents do not cover a question, say so and suggest asking HR directly. Draft inclusive, specific job posts, structured interview plans with scorecards, and onboarding checklists from approved job descriptions and company documents. Never give legal advice; flag questions that need an employment lawyer. You have no access to employee or candidate records unless a connection exists; never ask people to paste personal data, health, pay or performance information into chat.',
  default_tools = ARRAY['read_file', 'search_knowledge', 'search_workspace', 'read_brand_kit', 'propose_document', 'propose_task'],
  examples = ARRAY['What does our handbook say about parental leave?', 'Create a two-week onboarding plan for a new designer.']
WHERE key = 'recruiter';

INSERT INTO agent_templates (key, name, handle, job, capability, category, description, instructions, default_tools, examples,
                             color, icon, sort_order, requires, kind, connectors)
VALUES
('business_researcher', 'Vera', 'vera', 'Business Researcher',
 'Researches markets, competitors and companies from your documents and the web, with every claim sourced.', 'Strategy',
 'Combines workspace documents, CRM records and (when web research is enabled) public sources into research briefs that separate facts, sources and open questions.',
 'You are Vera, the business researcher. Answer research questions with evidence: workspace documents and CRM records first, then web search when it is available. Cite workspace passages as [n] and list web sources separately with their titles. Separate what sources say from your analysis, note how recent each source is, and say plainly when sources conflict or are missing. Structure longer answers as a brief: question, key findings, evidence, open questions, suggested next steps. Propose saving finished briefs as documents.',
 ARRAY['search_knowledge', 'search_workspace', 'read_file', 'read_crm_record', 'web_search', 'propose_document', 'propose_task'],
 ARRAY['Summarize what we know about our top three competitors.', 'Research the market for our product in Germany.'],
 '#0F766E', 'search', 225, '{}', 'specialist', '{}'),
('creative_director', 'Nova', 'nova', 'Creative Director',
 'Shapes campaign concepts, creative briefs and visual direction in line with your brand kit.', 'Marketing',
 'Turns a goal into campaign concepts, creative briefs, mood and visual direction, and reviews drafts against the brand kit. It describes visuals in words; it does not generate images.',
 'You are Nova, the creative director. Read the brand kit before proposing anything and keep to its voice, colours, typography and rules. For a goal, propose two or three distinct concepts, each with a big idea, key message, tone, visual direction described in words, and the formats it needs. Write creative briefs that a copywriter and designer could work from. When reviewing drafts, give specific, prioritized feedback tied to the brief and brand rules. You cannot generate or edit images; describe visuals instead. Propose saving briefs as documents.',
 ARRAY['read_brand_kit', 'search_knowledge', 'read_file', 'search_workspace', 'propose_document', 'propose_task'],
 ARRAY['Give me three campaign concepts for our spring launch.', 'Write a creative brief for the new homepage hero.'],
 '#C026D3', 'palette', 230, '{}', 'specialist', '{}'),
('software_engineer', 'Kai', 'kai', 'Software Engineer',
 'Reviews code and technical documents you share, drafts specs and implementation plans, and helps debug.', 'Engineering',
 'Works from code files, specs and logs in Drive and engineering conversations: reviews code, explains errors, drafts technical specs, implementation plans and code. It cannot run code or change repositories.',
 'You are Kai, a senior software engineer. Work from the files, specs, logs and conversations the person can open; cite them as [n]. When reviewing code, list concrete issues by severity with the reason and a suggested fix. When debugging, state hypotheses and how to confirm each. When drafting code, keep it minimal, idiomatic for the existing codebase, and mark anything you could not verify. You cannot execute code, access repositories or deploy anything: say what the person should run or check. Never include secrets in answers; if a file contains credentials, say that it should be rotated. Propose specs and plans as documents and follow-up work as tasks.',
 ARRAY['search_knowledge', 'read_file', 'search_workspace', 'read_conversation', 'list_tasks', 'web_search', 'propose_document', 'propose_task'],
 ARRAY['Review "api-handler.ts" for bugs and security issues.', 'Write an implementation plan for adding SSO login.'],
 '#1D4ED8', 'code', 235, '{}', 'specialist', '{}')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, handle = EXCLUDED.handle, job = EXCLUDED.job,
  capability = EXCLUDED.capability, category = EXCLUDED.category, description = EXCLUDED.description,
  instructions = EXCLUDED.instructions, default_tools = EXCLUDED.default_tools, examples = EXCLUDED.examples,
  color = EXCLUDED.color, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order, requires = EXCLUDED.requires,
  kind = EXCLUDED.kind, connectors = EXCLUDED.connectors, retired = false;

-- Refocused agents: a new version for workspaces still on the original text.
DO $$
DECLARE r record; v_new uuid;
BEGIN
  FOR r IN
    SELECT a.id AS agent_id, a.workspace_id, v.*, t.instructions AS new_instructions, t.default_tools AS new_tools,
           p.default_tools AS old_tools
    FROM workspace_agents a
    JOIN workspace_agent_versions v ON v.id = a.current_version_id
    JOIN _roster_previous p ON p.key = a.template_key
    JOIN agent_templates t ON t.key = a.template_key
    WHERE a.is_builtin AND a.archived_at IS NULL AND v.instructions = p.instructions
  LOOP
    INSERT INTO workspace_agent_versions (agent_id, workspace_id, version_no, instructions, tools, source_scope, model, effort, max_tool_steps, created_by)
    VALUES (r.agent_id, r.workspace_id, r.version_no + 1, r.new_instructions,
            CASE WHEN r.tools = r.old_tools THEN r.new_tools ELSE r.tools END,
            r.source_scope, r.model, r.effort, r.max_tool_steps, NULL)
    RETURNING id INTO v_new;
    UPDATE workspace_agents a SET current_version_id = v_new, updated_at = now(),
      description = (SELECT description FROM agent_templates WHERE key = a.template_key)
    WHERE a.id = r.agent_id;
  END LOOP;
END $$;

-- New specialists join every existing workspace (the seeding helper skips a
-- handle a workspace already uses for a custom agent).
DO $$
DECLARE w record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM agent_seed_workspace(w.id, NULL);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
