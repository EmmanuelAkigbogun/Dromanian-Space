-- ============================================================================
-- 20261004001300_agent_roster_and_team.sql
-- ----------------------------------------------------------------------------
-- Twelve role specialists plus a Team Chat coordinator, all on the same
-- engine. The previous eight built-in agents are archived (their
-- conversations stay readable) and new workspaces get the new roster.
--   * Readiness inputs: external connectors (honest "not connected" state),
--     brand kit folder, site address for SEO, CRM.
--   * Team runs: a coordinator delegates bounded tasks to specialists. Child
--     runs belong to the same requester, use the requester's access, cannot
--     delegate again, and are budgeted per team run.
--   * Durable execution: runs are executed by the worker through the jobs
--     table; a reclaimed run restarts cleanly and proposals are deduplicated.
--   * Private personal notes for the coach, calendar reads, vetted workspace
--     metrics, reviewed calendar events.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'specialist';
ALTER TABLE agent_templates DROP CONSTRAINT IF EXISTS agent_templates_kind_check;
ALTER TABLE agent_templates ADD CONSTRAINT agent_templates_kind_check CHECK (kind IN ('specialist', 'coordinator'));
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS connectors text[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS retired boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN agent_templates.connectors IS
  'External connections that enable extra actions. The base workflow works without them; connected actions stay unavailable until a connection exists.';

ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE OR REPLACE FUNCTION public.agent_known_tools()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_conversation', 'list_tasks',
               'read_crm_record', 'compute_csv_metrics', 'web_search',
               'propose_task', 'propose_document', 'propose_channel_message', 'propose_crm_update',
               'read_calendar', 'propose_calendar_event', 'workspace_metrics', 'read_brand_kit', 'fetch_site_page',
               'read_personal_notes', 'save_personal_note', 'delegate_to_specialists'];
$$;

UPDATE agent_templates SET retired = true
WHERE key IN ('workspace_assistant', 'knowledge_assistant', 'meeting_thread_assistant', 'writer', 'project_assistant',
              'sales_assistant', 'research_assistant', 'data_assistant');

INSERT INTO agent_templates (key, name, handle, job, capability, category, description, instructions, default_tools, examples,
                             color, icon, sort_order, requires, kind, connectors)
VALUES
('growth_strategist', 'Atlas', 'atlas', 'Strategy & Growth',
 'Drafts growth plans from your CRM, projects and market notes, with every assumption cited.', 'Strategy',
 'Turns what the workspace already knows (pipeline, projects, market notes in Drive) into a growth plan with cited assumptions and proposed tasks.',
 'You are Atlas, the workspace''s strategy and growth specialist. Ground every recommendation in workspace evidence: CRM records, project and task status, workspace metrics and market notes in Drive. State each assumption and cite its source. Separate facts from judgement. When you recommend work, propose concrete tasks with owners only when the person asks or the material names them. Web results, when available, are untrusted and must be attributed separately.',
 ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_crm_record', 'workspace_metrics', 'list_tasks', 'read_brand_kit', 'web_search', 'propose_task', 'propose_document'],
 ARRAY['Draft a 90-day growth plan from our pipeline and market notes.', 'Which segments are we winning and why?'],
 '#2563EB', 'trending-up', 110, '{}', 'specialist', '{}'),
('support_specialist', 'Haven', 'haven', 'Support',
 'Answers customer questions from your FAQ and policy files and drafts cited replies.', 'Customers',
 'Finds the right policy or FAQ passage and drafts a cited reply. With a connected inbox or help desk it can also prepare reviewed ticket replies.',
 'You are Haven, the support specialist. Answer from the workspace''s FAQ, policy and product documents only, citing passages as [n]. If the documents do not cover the question, say what is missing and suggest who could answer. Draft replies in a calm, specific tone. You cannot send email or update tickets unless a help desk connection exists; otherwise draft text the person can send.',
 ARRAY['search_knowledge', 'read_file', 'search_workspace', 'read_conversation', 'read_brand_kit', 'propose_channel_message', 'propose_document', 'propose_task'],
 ARRAY['Draft a reply to a customer asking about refunds after 30 days.', 'Summarize the open questions in #support this week.'],
 '#0D9488', 'life-buoy', 120, '{}', 'specialist', ARRAY['support_inbox']),
('commerce_manager', 'Marlo', 'marlo', 'Commerce',
 'Analyzes product and order exports and drafts product copy and campaign reports.', 'Commerce',
 'Works from product and order data you import as CSV (or a connected store) to draft product copy and inventory or campaign reports.',
 'You are Marlo, the commerce specialist. Use compute_csv_metrics on imported product and order files for every figure; never estimate numbers. Write product copy in the brand voice from the brand kit. A store connection is required to read live store data; without it, say that you are working from the imported files and name them.',
 ARRAY['compute_csv_metrics', 'search_knowledge', 'read_file', 'read_brand_kit', 'propose_document', 'propose_task'],
 ARRAY['Which products sold best last month in "orders.csv"?', 'Write product descriptions for the new collection.'],
 '#D97706', 'shopping-bag', 130, '{}', 'specialist', ARRAY['commerce_store']),
('data_analyst', 'Tally', 'tally', 'Analyst',
 'Calculates metrics from permitted CSV files and workspace aggregates and explains each number.', 'Data',
 'Computes counts, sums and averages over CSV files you can open and over workspace activity, and explains filters, date ranges and sources. It does not run arbitrary code.',
 'You are Tally, the analyst. Every number you report must come from compute_csv_metrics or workspace_metrics in this conversation. For each figure state the file or metric, the filters and the date range. Never add amounts in different currencies together. When the person wants a report, propose saving it as a document.',
 ARRAY['compute_csv_metrics', 'workspace_metrics', 'read_file', 'search_knowledge', 'propose_document'],
 ARRAY['How many tasks were completed per week this quarter?', 'Total revenue by region in "sales_q3.csv".'],
 '#475569', 'bar-chart', 140, '{}', 'specialist', '{}'),
('email_marketer', 'Wren', 'wren', 'Email Marketing',
 'Drafts email campaigns from your brand guidelines and approved templates.', 'Marketing',
 'Drafts campaigns, subject lines and sequences in your brand voice. Sending or scheduling needs an authorized email platform connection.',
 'You are Wren, the email marketing specialist. Follow the brand kit and any approved templates in Drive. Draft subject lines, preview text and body; suggest the audience segment in words. Only opted-in contacts may be emailed, and you cannot send or schedule anything: an email platform connection is required for that. Save drafts as documents for review.',
 ARRAY['read_brand_kit', 'search_knowledge', 'read_file', 'propose_document'],
 ARRAY['Draft a three-email onboarding sequence.', 'Write the launch announcement email for our new plan.'],
 '#DB2777', 'mail', 150, '{}', 'specialist', ARRAY['email_platform']),
('personal_coach', 'Sage', 'sage', 'Personal Coach',
 'Helps you plan routines from your own goals, calendar and tasks. Your notes stay private.', 'Personal',
 'Works only with your own goals, calendar and tasks. Notes you keep with Sage are private to you and are never used to answer anyone else.',
 'You are Sage, a personal coach for the person you are talking to. Use their private notes, calendar and tasks to propose realistic routines, priorities and reminders. Keep a supportive, practical tone. Save a private note only when the person asks you to remember something. Never suggest sharing their notes; they are private.',
 ARRAY['read_personal_notes', 'save_personal_note', 'read_calendar', 'list_tasks', 'propose_task'],
 ARRAY['Help me plan a focused week around my deadlines.', 'Remember that I want to protect Friday mornings for deep work.'],
 '#16A34A', 'sprout', 160, '{}', 'specialist', '{}'),
('sales_rep', 'Rio', 'rio', 'Sales',
 'Prepares deal briefings, call outlines and follow-ups from permitted CRM records.', 'Sales',
 'Summarizes contacts, companies and deals, prepares call outlines and drafts follow-ups. CRM changes go through your review; it never sends email.',
 'You are Rio, the sales specialist. Use read_crm_record for CRM facts and cite the record. Prepare briefings, call outlines and follow-up drafts. Report deal values with their currency and never add different currencies together. Propose CRM changes with propose_crm_update; they require approval. You cannot send email.',
 ARRAY['read_crm_record', 'search_workspace', 'search_knowledge', 'read_file', 'workspace_metrics', 'propose_crm_update', 'propose_task', 'propose_document'],
 ARRAY['Brief me on the Acme deal before tomorrow''s call.', 'Draft a follow-up for deals with no activity in two weeks.'],
 '#DC2626', 'briefcase', 170, ARRAY['crm'], 'specialist', '{}'),
('copywriter', 'Inka', 'inka', 'Copywriter',
 'Drafts and revises campaign copy in your brand voice and saves approved versions.', 'Marketing',
 'Writes and edits headlines, landing pages and campaign copy from your brand kit and selected files. Nothing is saved until you approve it.',
 'You are Inka, the copywriter. Read the brand kit before writing and follow its voice, vocabulary and rules. Use selected files as source material and never invent claims, figures or testimonials; mark gaps with [TODO]. Offer two or three options when tone is uncertain. Propose saving the approved version as a document.',
 ARRAY['read_brand_kit', 'read_file', 'search_knowledge', 'propose_document'],
 ARRAY['Write three headline options for the pricing page.', 'Tighten this product announcement to 120 words.'],
 '#7C3AED', 'pen', 180, '{}', 'specialist', '{}'),
('recruiter', 'Talia', 'talia', 'Recruiter',
 'Drafts job posts and interview plans from an approved job description.', 'People',
 'Turns an approved job description into a job post, scorecard and interview plan. Applicant data is only available through an authorized recruiting connection.',
 'You are Talia, the recruiting specialist. Work from the approved job description and company documents. Write inclusive, specific job posts and structured interview plans with scorecards. You have no access to candidate records unless a recruiting connection exists; never ask people to paste candidate personal data into chat.',
 ARRAY['read_file', 'search_knowledge', 'read_brand_kit', 'propose_document', 'propose_task'],
 ARRAY['Draft a job post from "Senior designer - JD".', 'Create an interview plan with a scorecard for this role.'],
 '#9333EA', 'users', 190, '{}', 'specialist', ARRAY['recruiting']),
('seo_specialist', 'Orbit', 'orbit', 'SEO Specialist',
 'Inspects pages of your configured site and proposes titles, briefs and fixes.', 'Marketing',
 'Reads pages on the site address set in AI settings, checks titles, headings and metadata, and proposes prioritized changes and content briefs.',
 'You are Orbit, the SEO specialist. Use fetch_site_page only for pages on the configured site. Check titles, meta descriptions, headings, internal links and content gaps, and propose prioritized changes with the reason for each. Search analytics are only available with a connection; without one, say your recommendations are based on page content alone.',
 ARRAY['fetch_site_page', 'search_knowledge', 'read_file', 'read_brand_kit', 'propose_document', 'propose_task'],
 ARRAY['Audit our homepage titles and headings.', 'Write a content brief for a "pricing" guide.'],
 '#0891B2', 'globe', 200, ARRAY['site_url'], 'specialist', ARRAY['search_analytics']),
('social_manager', 'Echo', 'echo', 'Social Manager',
 'Drafts channel-specific content calendars and posts from your brand kit.', 'Marketing',
 'Plans a content calendar and drafts posts per channel. Publishing or scheduling needs an authorized social account connection and your review.',
 'You are Echo, the social media specialist. Follow the brand kit. Draft posts adapted to each channel''s format and length, and lay out a content calendar as a table. You cannot publish or schedule posts without a social account connection; save drafts as documents for review.',
 ARRAY['read_brand_kit', 'search_knowledge', 'read_file', 'propose_document'],
 ARRAY['Plan two weeks of posts for our product launch.', 'Turn this blog post into three LinkedIn posts.'],
 '#E11D48', 'megaphone', 210, '{}', 'specialist', ARRAY['social_accounts']),
('executive_assistant', 'Juno', 'juno', 'Executive Assistant',
 'Prepares your daily briefing and meetings from your calendar, tasks and conversations.', 'Productivity',
 'Summarizes your day from your calendar, tasks and conversations, prepares meetings and proposes reviewed events and tasks. Inbox summaries need an email connection.',
 'You are Juno, an executive assistant for the person you are talking to. Build briefings from their calendar, tasks and the conversations they belong to. Be brief and specific: what needs attention, when, and why. Propose calendar events and tasks for review; never claim you scheduled something. Inbox access requires an email connection.',
 ARRAY['read_calendar', 'list_tasks', 'search_workspace', 'read_conversation', 'propose_task', 'propose_calendar_event', 'propose_channel_message'],
 ARRAY['Give me my briefing for today.', 'Prepare me for my 2pm meeting.'],
 '#4F46E5', 'calendar', 220, '{}', 'specialist', ARRAY['email_inbox']),
('team_coordinator', 'Team Lead', 'team', 'Team Chat coordinator',
 'Splits a request into tasks for the right specialists and combines their results.', 'Team',
 'Ask the whole team. The coordinator assigns bounded tasks to specialists, shows who did what, and combines the results with sources.',
 'You coordinate a team of specialist agents for the person you are talking to. Decide whether the request needs specialists; if it does, call delegate_to_specialists once with up to four focused tasks, each for the specialist best suited to it, and include the context each needs. Then combine their results into one answer. Attribute each part to the specialist who produced it and keep their citations. Do not invent results for a specialist who failed; say what is missing. Specialists act with the person''s own access and their actions still need approval.',
 ARRAY['delegate_to_specialists', 'search_workspace', 'search_knowledge', 'read_file'],
 ARRAY['Plan our product launch: positioning, launch email and social posts.', 'Prepare a customer review: deal status, open support questions and next steps.'],
 '#111827', 'users-round', 5, '{}', 'coordinator', '{}')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, handle = EXCLUDED.handle, job = EXCLUDED.job,
  capability = EXCLUDED.capability, category = EXCLUDED.category, description = EXCLUDED.description,
  instructions = EXCLUDED.instructions, default_tools = EXCLUDED.default_tools, examples = EXCLUDED.examples,
  color = EXCLUDED.color, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order, requires = EXCLUDED.requires,
  kind = EXCLUDED.kind, connectors = EXCLUDED.connectors, retired = false;

-- Seeding helper shared by existing workspaces, new workspaces and ensure_workspace_agents().
CREATE OR REPLACE FUNCTION public.agent_seed_workspace(p_workspace_id uuid, p_created_by uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE t agent_templates%ROWTYPE; v_agent uuid; v_version uuid; v_created integer := 0; v_model text;
BEGIN
  v_model := coalesce((SELECT default_model FROM workspace_ai_settings WHERE workspace_id = p_workspace_id), 'claude-opus-5-5');
  -- Retired built-ins leave the roster; their conversations remain readable.
  UPDATE workspace_agents a SET archived_at = now(), status = 'disabled', updated_at = now()
  FROM agent_templates tpl
  WHERE a.workspace_id = p_workspace_id AND a.is_builtin AND a.template_key = tpl.key AND tpl.retired AND a.archived_at IS NULL;
  FOR t IN SELECT * FROM agent_templates WHERE NOT retired ORDER BY sort_order LOOP
    IF NOT EXISTS (SELECT 1 FROM workspace_agents WHERE workspace_id = p_workspace_id AND template_key = t.key AND is_builtin) THEN
      v_agent := NULL;
      INSERT INTO workspace_agents (workspace_id, template_key, name, handle, description, category, color, icon, is_builtin, created_by)
      VALUES (p_workspace_id, t.key, t.name, t.handle, t.description, t.category, t.color, t.icon, true, NULL)
      ON CONFLICT (workspace_id, handle) DO NOTHING
      RETURNING id INTO v_agent;
      IF v_agent IS NOT NULL THEN
        INSERT INTO workspace_agent_versions (agent_id, workspace_id, version_no, instructions, tools, model, effort, created_by)
        VALUES (v_agent, p_workspace_id, 1, t.instructions, t.default_tools, v_model, 'medium', p_created_by)
        RETURNING id INTO v_version;
        UPDATE workspace_agents SET current_version_id = v_version WHERE id = v_agent;
        v_created := v_created + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN v_created;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_workspace_agents(p_workspace_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_member(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '42501';
  END IF;
  PERFORM ai_settings_for(p_workspace_id);
  RETURN agent_seed_workspace(p_workspace_id, auth.uid());
END $$;

CREATE OR REPLACE FUNCTION public.on_workspace_created_agents() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM agent_seed_workspace(NEW.id, NULL);
  RETURN NEW;
END $$;

DO $$
DECLARE w record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM agent_seed_workspace(w.id, NULL);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Workspace AI settings: brand kit and site; external connectors
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_ai_settings ADD COLUMN IF NOT EXISTS brand_kit_folder_id uuid;
ALTER TABLE workspace_ai_settings ADD COLUMN IF NOT EXISTS site_url text;
ALTER TABLE workspace_ai_settings DROP CONSTRAINT IF EXISTS workspace_ai_settings_site_url_check;
ALTER TABLE workspace_ai_settings ADD CONSTRAINT workspace_ai_settings_site_url_check
  CHECK (site_url IS NULL OR site_url ~ '^https://[a-z0-9.-]+\.[a-z]{2,}(/.*)?$');

CREATE OR REPLACE FUNCTION public.ai_update_settings(p_workspace_id uuid, p_patch jsonb)
RETURNS workspace_ai_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v workspace_ai_settings%ROWTYPE; v_folder uuid;
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can change AI settings' USING ERRCODE = '42501';
  END IF;
  PERFORM ai_settings_for(p_workspace_id);
  v_folder := nullif(p_patch ->> 'brand_kit_folder_id', '')::uuid;
  IF v_folder IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM drive_items WHERE id = v_folder AND workspace_id = p_workspace_id AND kind = 'folder' AND trashed_at IS NULL
       AND drive_viewable_by(id, auth.uid())) THEN
    RAISE EXCEPTION 'Choose a folder in this workspace that you can open' USING ERRCODE = '22023';
  END IF;
  UPDATE workspace_ai_settings SET
    enabled = coalesce((p_patch ->> 'enabled')::boolean, enabled),
    default_model = coalesce(p_patch ->> 'default_model', default_model),
    -- ARRAY(...) over a missing key is an empty array, not NULL: only replace when present.
    allowed_models = CASE WHEN p_patch ? 'allowed_models' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'allowed_models')) ELSE allowed_models END,
    monthly_token_budget = CASE WHEN p_patch ? 'monthly_token_budget' THEN (p_patch ->> 'monthly_token_budget')::bigint ELSE monthly_token_budget END,
    per_user_daily_token_budget = CASE WHEN p_patch ? 'per_user_daily_token_budget' THEN (p_patch ->> 'per_user_daily_token_budget')::bigint ELSE per_user_daily_token_budget END,
    max_concurrent_runs = coalesce((p_patch ->> 'max_concurrent_runs')::integer, max_concurrent_runs),
    web_research_enabled = coalesce((p_patch ->> 'web_research_enabled')::boolean, web_research_enabled),
    mention_reply_policy = coalesce(p_patch ->> 'mention_reply_policy', mention_reply_policy),
    brand_kit_folder_id = CASE WHEN p_patch ? 'brand_kit_folder_id' THEN v_folder ELSE brand_kit_folder_id END,
    site_url = CASE WHEN p_patch ? 'site_url' THEN nullif(lower(btrim(p_patch ->> 'site_url')), '') ELSE site_url END,
    updated_by = auth.uid(), updated_at = now()
  WHERE workspace_id = p_workspace_id RETURNING * INTO v;
  IF cardinality(v.allowed_models) = 0 OR NOT v.default_model = ANY(v.allowed_models) THEN
    RAISE EXCEPTION 'The default model must be one of the allowed models' USING ERRCODE = '22023';
  END IF;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, auth.uid(), 'ai_settings_changed', 'workspace', p_workspace_id, p_patch);
  RETURN v;
END $$;

-- Repair settings emptied by the earlier version of ai_update_settings.
UPDATE workspace_ai_settings SET allowed_models = ARRAY['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']
WHERE cardinality(allowed_models) = 0;

-- External services a workspace has authorized. No integration is connected
-- by this migration; rows are written only by a real connection flow.
CREATE TABLE IF NOT EXISTS public.workspace_connectors (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('support_inbox', 'commerce_store', 'email_platform', 'recruiting', 'search_analytics',
                                     'social_accounts', 'email_inbox')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'revoked')),
  display_name text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind)
);
ALTER TABLE workspace_connectors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workspace_connectors_read" ON workspace_connectors;
CREATE POLICY "workspace_connectors_read" ON workspace_connectors FOR SELECT TO authenticated
  USING (public.user_is_workspace_member(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON workspace_connectors FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Runs: delegation, attempts, served model, message kinds
-- ---------------------------------------------------------------------------
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS served_model text;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_trigger_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_trigger_check
  CHECK (trigger IN ('interactive', 'mention', 'automation', 'thread_summary', 'delegation'));
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_depth_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_depth_check CHECK (depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_run_id IS NULL));
CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat';
ALTER TABLE agent_messages DROP CONSTRAINT IF EXISTS agent_messages_kind_check;
ALTER TABLE agent_messages ADD CONSTRAINT agent_messages_kind_check CHECK (kind IN ('chat', 'delegation'));

-- The model that actually answered (it can differ after a refusal fallback).
CREATE OR REPLACE FUNCTION public.agent_runs_served_model() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.usage IS DISTINCT FROM OLD.usage AND NEW.usage ? 'model' THEN
    NEW.served_model := NEW.usage ->> 'model';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_agent_runs_served_model ON agent_runs;
CREATE TRIGGER trg_agent_runs_served_model BEFORE UPDATE OF usage ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.agent_runs_served_model();

CREATE TABLE IF NOT EXISTS public.agent_team_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  ordinal integer NOT NULL,
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (parent_run_id, idempotency_key),
  UNIQUE (child_run_id),
  FOREIGN KEY (parent_run_id, workspace_id) REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (child_run_id, workspace_id) REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES workspace_agents(id, workspace_id) ON DELETE CASCADE
);
ALTER TABLE agent_team_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_team_tasks_own" ON agent_team_tasks;
CREATE POLICY "agent_team_tasks_own" ON agent_team_tasks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = agent_team_tasks.parent_run_id AND r.requested_by = auth.uid())
         AND public.user_is_workspace_member(agent_team_tasks.workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON agent_team_tasks FROM anon, authenticated;

-- Creates specialist runs for a coordinator run. Delegation is one level deep,
-- at most 4 tasks per call and 8 per team run; repeating a call (for example
-- after a worker restart) returns the existing tasks instead of new runs.
CREATE OR REPLACE FUNCTION public.agent_delegate(p_parent_run_id uuid, p_tasks jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_parent agent_runs%ROWTYPE; t jsonb; v_agent workspace_agents%ROWTYPE; v_version workspace_agent_versions%ROWTYPE;
  v_key text; v_existing agent_team_tasks%ROWTYPE; v_count integer; v_ord integer; v_run uuid; v_in uuid; v_out uuid;
  v_out_list jsonb := '[]'::jsonb; v_instruction text; v_kind text;
BEGIN
  SELECT * INTO v_parent FROM agent_runs WHERE id = p_parent_run_id FOR UPDATE;
  IF v_parent.id IS NULL OR v_parent.status <> 'running' THEN RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000'; END IF;
  IF v_parent.depth > 0 THEN RAISE EXCEPTION 'Specialists cannot delegate further' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_tasks) <> 'array' OR jsonb_array_length(p_tasks) NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'Delegate between 1 and 4 tasks at a time' USING ERRCODE = '22023';
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(p_tasks) LOOP
    v_instruction := btrim(coalesce(t ->> 'instruction', ''));
    v_key := encode(extensions.digest(convert_to((t ->> 'agent_id') || ':' || v_instruction, 'UTF8'), 'sha256'), 'hex');
    SELECT * INTO v_existing FROM agent_team_tasks WHERE parent_run_id = p_parent_run_id AND idempotency_key = v_key;
    IF v_existing.id IS NOT NULL THEN
      v_out_list := v_out_list || jsonb_build_object('task_id', v_existing.id, 'child_run_id', v_existing.child_run_id,
        'agent_id', v_existing.agent_id, 'reused', true);
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_count FROM agent_team_tasks WHERE parent_run_id = p_parent_run_id;
    IF v_count >= 8 THEN RAISE EXCEPTION 'This team run has reached its delegation budget (8 tasks)' USING ERRCODE = '53400'; END IF;
    IF length(v_instruction) = 0 OR length(v_instruction) > 4000 THEN
      RAISE EXCEPTION 'Each task needs an instruction of up to 4000 characters' USING ERRCODE = '22023';
    END IF;
    SELECT a.* INTO v_agent FROM workspace_agents a
    WHERE a.id = nullif(t ->> 'agent_id', '')::uuid AND a.workspace_id = v_parent.workspace_id;
    SELECT tp.kind INTO v_kind FROM agent_templates tp WHERE tp.key = v_agent.template_key;
    IF v_agent.id IS NULL OR v_agent.status <> 'active' OR v_agent.archived_at IS NOT NULL
       OR NOT agent_visible_to(v_agent.id, v_parent.requested_by) OR coalesce(v_kind, 'specialist') <> 'specialist' THEN
      RAISE EXCEPTION 'A requested specialist is not available' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_version FROM workspace_agent_versions WHERE id = v_agent.current_version_id;
    v_ord := v_count + 1;
    v_run := gen_random_uuid();
    INSERT INTO agent_messages (conversation_id, workspace_id, role, content, status, run_id, scope, created_by, kind)
    VALUES (v_parent.conversation_id, v_parent.workspace_id, 'user', v_instruction, 'complete', v_run, v_parent.scope,
            v_parent.requested_by, 'delegation')
    RETURNING id INTO v_in;
    INSERT INTO agent_messages (conversation_id, workspace_id, role, content, status, run_id, created_by, kind)
    VALUES (v_parent.conversation_id, v_parent.workspace_id, 'assistant', '', 'streaming', v_run, NULL, 'delegation')
    RETURNING id INTO v_out;
    INSERT INTO agent_runs (id, workspace_id, conversation_id, agent_id, agent_version_id, requested_by, input_message_id,
                            output_message_id, trigger, destination, scope, model, effort, idempotency_key, parent_run_id, depth)
    VALUES (v_run, v_parent.workspace_id, v_parent.conversation_id, v_agent.id, v_version.id, v_parent.requested_by, v_in, v_out,
            'delegation', '{"type":"private"}', v_parent.scope, v_version.model, v_version.effort,
            'team:' || p_parent_run_id || ':' || v_key, p_parent_run_id, 1);
    INSERT INTO ai_usage_ledger (workspace_id, user_id, run_id, kind, model, tokens)
    VALUES (v_parent.workspace_id, v_parent.requested_by, v_run, 'reservation', v_version.model, 10000);
    INSERT INTO agent_team_tasks (workspace_id, parent_run_id, child_run_id, agent_id, ordinal, instruction, idempotency_key)
    VALUES (v_parent.workspace_id, p_parent_run_id, v_run, v_agent.id, v_ord, v_instruction, v_key)
    RETURNING * INTO v_existing;
    v_out_list := v_out_list || jsonb_build_object('task_id', v_existing.id, 'child_run_id', v_run, 'agent_id', v_agent.id, 'reused', false);
  END LOOP;
  RETURN v_out_list;
END $$;

-- Records a finished specialist task on its team run. The child's sources
-- become the parent's sources, so sharing the combined answer is checked
-- against everything any specialist read.
CREATE OR REPLACE FUNCTION public.agent_settle_team_task(p_task_id uuid)
RETURNS agent_team_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v agent_team_tasks%ROWTYPE; v_child agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO v FROM agent_team_tasks WHERE id = p_task_id FOR UPDATE;
  IF v.id IS NULL THEN RETURN v; END IF;
  SELECT * INTO v_child FROM agent_runs WHERE id = v.child_run_id;
  INSERT INTO agent_run_sources (run_id, workspace_id, kind, ref_id, item_id, channel_id, label)
  SELECT v.parent_run_id, s.workspace_id, s.kind, s.ref_id, s.item_id, s.channel_id, s.label
  FROM agent_run_sources s WHERE s.run_id = v.child_run_id
  ON CONFLICT (run_id, kind, ref_id) DO NOTHING;
  UPDATE agent_team_tasks SET
    status = CASE v_child.status WHEN 'awaiting_approval' THEN 'completed' WHEN 'queued' THEN 'queued' ELSE v_child.status END,
    finished_at = CASE WHEN v_child.status IN ('queued', 'running') THEN NULL ELSE coalesce(finished_at, now()) END
  WHERE id = p_task_id RETURNING * INTO v;
  RETURN v;
END $$;

-- Claim: as before, plus a clean restart when a stale run is reclaimed (the
-- previous worker stopped): partial output and its citations are discarded.
CREATE OR REPLACE FUNCTION public.agent_claim_run(p_run_id uuid, p_worker text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_run agent_runs%ROWTYPE; v_version workspace_agent_versions%ROWTYPE; v_agent workspace_agents%ROWTYPE; v_kind text;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_found'); END IF;
  IF v_run.status NOT IN ('queued', 'running') THEN RETURN jsonb_build_object('claimed', false, 'reason', v_run.status); END IF;
  IF v_run.status = 'running' AND v_run.worker IS DISTINCT FROM p_worker AND v_run.heartbeat_at > now() - interval '90 seconds' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'running_elsewhere');
  END IF;
  IF v_run.cancel_requested_at IS NOT NULL THEN
    PERFORM agent_finish_run(p_run_id, p_worker, 'cancelled', NULL, NULL, 'cancelled', 'Cancelled before it started');
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancelled');
  END IF;
  IF NOT user_is_workspace_member(v_run.workspace_id, v_run.requested_by) THEN
    PERFORM agent_finish_run(p_run_id, p_worker, 'failed', NULL, NULL, 'membership_removed', 'The requester is no longer a workspace member');
    RETURN jsonb_build_object('claimed', false, 'reason', 'membership_removed');
  END IF;
  IF v_run.status = 'running' THEN
    DELETE FROM agent_citations WHERE run_id = p_run_id;
    UPDATE agent_messages SET content = '', status = 'streaming', updated_at = now() WHERE id = v_run.output_message_id;
    PERFORM agent_add_event(p_run_id, 'status', jsonb_build_object('restarted', true, 'attempt', v_run.attempt + 1));
  END IF;
  UPDATE agent_runs SET status = 'running', worker = p_worker, started_at = coalesce(started_at, now()), heartbeat_at = now(),
    attempt = attempt + 1
  WHERE id = p_run_id RETURNING * INTO v_run;
  SELECT * INTO v_version FROM workspace_agent_versions WHERE id = v_run.agent_version_id;
  SELECT * INTO v_agent FROM workspace_agents WHERE id = v_run.agent_id;
  SELECT kind INTO v_kind FROM agent_templates WHERE key = v_agent.template_key;
  RETURN jsonb_build_object('claimed', true, 'run', to_jsonb(v_run), 'version', to_jsonb(v_version),
    'agent', jsonb_build_object('id', v_agent.id, 'name', v_agent.name, 'handle', v_agent.handle, 'template_key', v_agent.template_key,
                                'kind', coalesce(v_kind, 'specialist')),
    'settings', to_jsonb(ai_settings_for(v_run.workspace_id)));
END $$;

-- Finishes a run exactly once (as in 20261004000600). Changes: notification
-- links use the app's conversation route, and specialists inside a team run
-- do not notify separately (the team run does). Approvals still notify.
-- (awaiting_approval when proposals are pending) and notifications.
CREATE OR REPLACE FUNCTION public.agent_finish_run(p_run_id uuid, p_worker text, p_status text, p_content text,
  p_usage jsonb, p_error_code text, p_error_message text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_run agent_runs%ROWTYPE; v_final text; v_pending integer; v_reserved bigint; v_agent text; v_msg_status text;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RETURN 'not_found'; END IF;
  IF v_run.status IN ('completed', 'failed', 'cancelled', 'interrupted', 'awaiting_approval') THEN RETURN v_run.status; END IF;
  IF v_run.status = 'running' AND v_run.worker IS DISTINCT FROM p_worker AND p_worker IS NOT NULL THEN RETURN 'not_owner'; END IF;
  SELECT count(*) INTO v_pending FROM agent_action_proposals WHERE run_id = p_run_id AND status = 'pending';
  v_final := CASE WHEN p_status = 'completed' AND v_pending > 0 THEN 'awaiting_approval' ELSE p_status END;
  IF v_final NOT IN ('awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted') THEN v_final := 'failed'; END IF;
  v_msg_status := CASE v_final WHEN 'awaiting_approval' THEN 'complete' WHEN 'completed' THEN 'complete' ELSE v_final END;

  UPDATE agent_runs SET status = v_final, finished_at = now(), heartbeat_at = now(), usage = coalesce(p_usage, usage),
    error_code = left(p_error_code, 60), error_message = left(p_error_message, 1000)
  WHERE id = p_run_id;
  UPDATE agent_messages SET content = CASE WHEN p_content IS NULL THEN content ELSE left(p_content, 200000) END,
    status = v_msg_status, updated_at = now()
  WHERE id = v_run.output_message_id;
  IF v_final IN ('failed', 'cancelled', 'interrupted') THEN
    UPDATE agent_action_proposals SET status = 'cancelled', error = 'Run ' || v_final
    WHERE run_id = p_run_id AND status = 'pending' AND v_final = 'cancelled';
  END IF;

  -- Usage ledger: release the reservation, record actual usage.
  SELECT coalesce(sum(tokens), 0) INTO v_reserved FROM ai_usage_ledger WHERE run_id = p_run_id AND kind IN ('reservation', 'release');
  IF v_reserved <> 0 THEN
    INSERT INTO ai_usage_ledger (workspace_id, user_id, run_id, kind, model, tokens)
    VALUES (v_run.workspace_id, v_run.requested_by, p_run_id, 'release', v_run.model, -v_reserved);
  END IF;
  IF p_usage IS NOT NULL AND p_usage <> '{}'::jsonb THEN
    INSERT INTO ai_usage_ledger (workspace_id, user_id, run_id, kind, model, tokens, input_tokens, output_tokens,
                                 cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (v_run.workspace_id, v_run.requested_by, p_run_id, CASE WHEN v_final = 'failed' THEN 'failure' ELSE 'usage' END,
            coalesce(p_usage ->> 'model', v_run.model),
            coalesce((p_usage ->> 'input_tokens')::bigint, 0) + coalesce((p_usage ->> 'output_tokens')::bigint, 0)
              + coalesce((p_usage ->> 'cache_write_tokens')::bigint, 0),
            coalesce((p_usage ->> 'input_tokens')::bigint, 0), coalesce((p_usage ->> 'output_tokens')::bigint, 0),
            coalesce((p_usage ->> 'cache_read_tokens')::bigint, 0), coalesce((p_usage ->> 'cache_write_tokens')::bigint, 0),
            (p_usage ->> 'cost_usd')::numeric);
  END IF;

  SELECT name INTO v_agent FROM workspace_agents WHERE id = v_run.agent_id;
  IF v_final = 'awaiting_approval' THEN
    INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, workspace_id)
    VALUES (v_run.requested_by, 'approval_needed', v_agent || ' needs your approval',
            v_pending || ' proposed action' || CASE WHEN v_pending = 1 THEN '' ELSE 's' END || ' to review.',
            '/agents/conversations/' || v_run.conversation_id, 'messaging', 'agent_run', p_run_id, v_run.workspace_id);
  ELSIF v_final = 'failed' AND v_run.trigger <> 'delegation' THEN
    INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, workspace_id)
    VALUES (v_run.requested_by, 'agent_failed', v_agent || ' could not finish',
            coalesce(left(p_error_message, 200), 'The run failed.'), '/agents/conversations/' || v_run.conversation_id,
            'messaging', 'agent_run', p_run_id, v_run.workspace_id);
  ELSIF v_final = 'completed' AND v_run.trigger NOT IN ('interactive', 'delegation') THEN
    INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, workspace_id)
    VALUES (v_run.requested_by, 'agent_completed', v_agent || ' finished', 'Your result is ready.',
            '/agents/conversations/' || v_run.conversation_id, 'messaging', 'agent_run', p_run_id, v_run.workspace_id);
  END IF;
  RETURN v_final;
END $$;


-- Notifications created with the old link format open the same conversation.
UPDATE notifications SET link = replace(link, '/agents/c/', '/agents/conversations/') WHERE link LIKE '/agents/c/%';

-- Interrupted only when no worker will pick the run up again: runs with a
-- live agent.run job (their own or their team run's) are left to the worker.
CREATE OR REPLACE FUNCTION public.agent_recover_stale_runs()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT ar.id FROM agent_runs ar
    WHERE ((ar.status = 'running' AND ar.heartbeat_at < now() - interval '2 minutes')
        OR (ar.status = 'queued' AND ar.created_at < now() - interval '10 minutes'))
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.kind = 'agent.run' AND j.status IN ('queued', 'running')
          AND j.idempotency_key IN ('run:' || ar.id, 'run:' || coalesce(ar.parent_run_id, ar.id)))
  LOOP
    PERFORM agent_finish_run(r.id, NULL, 'interrupted', NULL, NULL, 'interrupted',
      'The run stopped before finishing (the worker may have restarted). Retry to run it again.');
    UPDATE agent_team_tasks SET status = 'interrupted', finished_at = now() WHERE child_run_id = r.id AND finished_at IS NULL;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Cancellation reaches the specialists of a team run too.
CREATE OR REPLACE FUNCTION public.agent_cancel_run(p_run_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_run agent_runs%ROWTYPE; c record;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id AND requested_by = auth.uid() FOR UPDATE;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = '42501'; END IF;
  UPDATE agent_action_proposals SET status = 'cancelled', error = 'Run cancelled'
  WHERE status = 'pending' AND run_id IN (SELECT p_run_id UNION SELECT id FROM agent_runs WHERE parent_run_id = p_run_id);
  FOR c IN SELECT id, status FROM agent_runs WHERE parent_run_id = p_run_id AND status IN ('queued', 'running') LOOP
    IF c.status = 'queued' THEN
      PERFORM agent_finish_run(c.id, NULL, 'cancelled', NULL, NULL, 'cancelled', 'Cancelled');
    ELSE
      UPDATE agent_runs SET cancel_requested_at = now() WHERE id = c.id;
    END IF;
  END LOOP;
  IF v_run.status = 'queued' THEN
    RETURN agent_finish_run(p_run_id, NULL, 'cancelled', NULL, NULL, 'cancelled', 'Cancelled');
  ELSIF v_run.status = 'running' THEN
    UPDATE agent_runs SET cancel_requested_at = now() WHERE id = p_run_id;
    RETURN 'cancelling';
  ELSIF v_run.status = 'awaiting_approval' THEN
    UPDATE agent_runs SET status = 'cancelled' WHERE id = p_run_id;
    RETURN 'cancelled';
  END IF;
  RETURN v_run.status;
END $$;

-- ---------------------------------------------------------------------------
-- Proposals: dedupe across restarts; reviewed calendar events
-- ---------------------------------------------------------------------------
ALTER TABLE agent_action_proposals DROP CONSTRAINT IF EXISTS agent_action_proposals_action_type_check;
ALTER TABLE agent_action_proposals ADD CONSTRAINT agent_action_proposals_action_type_check
  CHECK (action_type IN ('create_task', 'save_document', 'post_message', 'update_crm_record', 'create_event'));

CREATE OR REPLACE FUNCTION public.agent_action_audience(p_workspace_id uuid, p_actor uuid, p_action_type text, p_arguments jsonb)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_users uuid[] := ARRAY[p_actor];
BEGIN
  IF p_action_type = 'post_message' THEN
    SELECT array_agg(cm.user_id) INTO v_users FROM channel_members cm
    WHERE cm.channel_id = (p_arguments ->> 'channel_id')::uuid AND user_is_channel_member(cm.channel_id, cm.user_id);
  ELSIF p_action_type = 'create_task' THEN
    SELECT array_agg(DISTINCT u) INTO v_users FROM (
      SELECT p_actor AS u
      UNION SELECT x::uuid FROM jsonb_array_elements_text(coalesce(p_arguments -> 'assignee_ids', '[]')) x
      UNION SELECT pm.user_id FROM project_members pm WHERE pm.project_id = nullif(p_arguments ->> 'project_id', '')::uuid
    ) s;
  ELSIF p_action_type = 'save_document' AND nullif(p_arguments ->> 'folder_id', '') IS NOT NULL THEN
    SELECT array_agg(wm.user_id) INTO v_users FROM workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND (wm.user_id = p_actor OR drive_viewable_by((p_arguments ->> 'folder_id')::uuid, wm.user_id));
  ELSIF p_action_type IN ('update_crm_record', 'create_event') THEN
    -- CRM records and calendar events are visible to the whole workspace.
    SELECT array_agg(wm.user_id) INTO v_users FROM workspace_members wm WHERE wm.workspace_id = p_workspace_id;
  END IF;
  RETURN coalesce(v_users, ARRAY[p_actor]);
END $$;

CREATE OR REPLACE FUNCTION public.agent_create_proposal(p_run_id uuid, p_tool_use_id text, p_action_type text,
  p_arguments jsonb, p_summary text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_run agent_runs%ROWTYPE; v_gaps jsonb; v_id uuid; v_inv uuid; v_existing agent_action_proposals%ROWTYPE; v_dest jsonb;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000'; END IF;
  -- The same action proposed again (a retried tool call or a restarted run) returns the original card.
  SELECT * INTO v_existing FROM agent_action_proposals
  WHERE run_id = p_run_id AND (idempotency_key = p_run_id || ':' || p_tool_use_id
     OR (arguments_hash = agent_hash_arguments(p_arguments) AND action_type = p_action_type AND status IN ('pending', 'executing', 'executed')))
  LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'proposed', 'proposal_id', v_existing.id, 'reused', true);
  END IF;
  IF p_action_type = 'post_message' AND NOT user_is_channel_member((p_arguments ->> 'channel_id')::uuid, v_run.requested_by) THEN
    RETURN jsonb_build_object('status', 'denied', 'reason', 'The requester is not a member of that conversation.');
  END IF;
  v_gaps := agent_audience_gaps(p_run_id, agent_action_audience(v_run.workspace_id, v_run.requested_by, p_action_type, p_arguments));
  IF jsonb_array_length(v_gaps) > 0 THEN
    RETURN jsonb_build_object('status', 'blocked_audience', 'sources', v_gaps,
      'reason', 'Some people who would see this result cannot open sources it was based on. Keep the result private, or share those sources first.');
  END IF;
  v_dest := CASE p_action_type
    WHEN 'post_message' THEN jsonb_build_object('type', 'channel', 'channel_id', p_arguments ->> 'channel_id', 'parent_id', p_arguments ->> 'parent_id')
    WHEN 'create_task' THEN jsonb_build_object('type', 'task', 'project_id', p_arguments ->> 'project_id')
    WHEN 'save_document' THEN jsonb_build_object('type', 'drive', 'folder_id', p_arguments ->> 'folder_id')
    WHEN 'create_event' THEN jsonb_build_object('type', 'calendar')
    ELSE jsonb_build_object('type', p_action_type) END;
  SELECT id INTO v_inv FROM agent_tool_invocations WHERE run_id = p_run_id AND provider_tool_use_id = p_tool_use_id;
  INSERT INTO agent_action_proposals (workspace_id, run_id, conversation_id, invocation_id, action_type, arguments, arguments_hash,
                                      summary, destination, requested_for, idempotency_key)
  VALUES (v_run.workspace_id, p_run_id, v_run.conversation_id, v_inv, p_action_type, p_arguments, agent_hash_arguments(p_arguments),
          left(p_summary, 500), v_dest, v_run.requested_by, p_run_id || ':' || p_tool_use_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('status', 'proposed', 'proposal_id', v_id);
END $$;

-- The executor from 20261004001100 keeps handling the original actions.
ALTER FUNCTION public.agent_execute_proposal(uuid) RENAME TO agent_execute_proposal_core;
REVOKE EXECUTE ON FUNCTION public.agent_execute_proposal_core(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.agent_execute_proposal(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE p agent_action_proposals%ROWTYPE; v_gaps jsonb; v_event uuid; v_start timestamptz; v_end timestamptz; v_user text;
BEGIN
  SELECT * INTO p FROM agent_action_proposals WHERE id = p_id;
  IF p.action_type <> 'create_event' THEN RETURN agent_execute_proposal_core(p_id); END IF;
  IF NOT user_is_workspace_member(p.workspace_id, p.requested_for) THEN
    RAISE EXCEPTION 'You are no longer a member of this workspace' USING ERRCODE = '42501';
  END IF;
  v_gaps := agent_audience_gaps(p.run_id, agent_action_audience(p.workspace_id, p.requested_for, p.action_type, p.arguments));
  IF jsonb_array_length(v_gaps) > 0 THEN
    RAISE EXCEPTION 'Some people who would see this cannot open its sources anymore' USING ERRCODE = '42501';
  END IF;
  v_start := (p.arguments ->> 'start_at')::timestamptz;
  v_end := (p.arguments ->> 'end_at')::timestamptz;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'The event needs a start before its end' USING ERRCODE = '22023';
  END IF;
  INSERT INTO calendar_events (workspace_id, user_id, title, description, start_at, end_at, all_day, location)
  VALUES (p.workspace_id, p.requested_for, left(p.arguments ->> 'title', 300), p.arguments ->> 'description', v_start, v_end,
          coalesce((p.arguments ->> 'all_day')::boolean, false), nullif(p.arguments ->> 'location', ''))
  RETURNING id INTO v_event;
  FOR v_user IN SELECT jsonb_array_elements_text(coalesce(p.arguments -> 'participant_ids', '[]')) LOOP
    IF NOT user_is_workspace_member(p.workspace_id, v_user::uuid) THEN
      RAISE EXCEPTION 'A participant is not a workspace member' USING ERRCODE = '42501';
    END IF;
    INSERT INTO event_participants (event_id, user_id) VALUES (v_event, v_user::uuid) ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN jsonb_build_object('event_id', v_event, 'link', '/calendar?event=' || v_event);
END $$;

-- ---------------------------------------------------------------------------
-- Tools: calendar, brand kit, personal notes, workspace metrics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_calendar_for(p_actor uuid, p_workspace_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(id uuid, title text, description text, start_at timestamptz, end_at timestamptz, all_day boolean, location text,
  organizer text, participants text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT user_is_workspace_member(p_workspace_id, p_actor) OR p_to <= p_from OR p_to - p_from > interval '62 days' THEN RETURN; END IF;
  RETURN QUERY
  SELECT e.id, e.title, e.description, e.start_at, e.end_at, coalesce(e.all_day, false), e.location,
    (SELECT coalesce(pr.display_name, pr.username) FROM profiles pr WHERE pr.id = e.user_id),
    coalesce(ARRAY(SELECT coalesce(pr.display_name, pr.username) FROM event_participants ep JOIN profiles pr ON pr.id = ep.user_id
                   WHERE ep.event_id = e.id), '{}')
  FROM calendar_events e
  WHERE e.workspace_id = p_workspace_id AND e.deleted_at IS NULL AND e.start_at < p_to AND e.end_at > p_from
    AND (e.user_id = p_actor OR EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id = p_actor))
  ORDER BY e.start_at
  LIMIT 200;
END $$;

-- Documents and files in the brand kit folder (and its subfolders) the actor can open.
CREATE OR REPLACE FUNCTION public.agent_brand_kit_items_for(p_actor uuid, p_workspace_id uuid)
RETURNS TABLE(id uuid, name text, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH RECURSIVE tree AS (
    SELECT i.id, i.name, i.kind, 0 AS depth FROM drive_items i
    JOIN workspace_ai_settings s ON s.brand_kit_folder_id = i.id AND s.workspace_id = p_workspace_id
    WHERE i.workspace_id = p_workspace_id AND i.trashed_at IS NULL
    UNION ALL
    SELECT c.id, c.name, c.kind, t.depth + 1 FROM drive_items c JOIN tree t ON c.parent_id = t.id
    WHERE c.trashed_at IS NULL AND t.depth < 5
  )
  SELECT t.id, t.name, t.kind FROM tree t
  WHERE t.kind <> 'folder' AND user_is_workspace_member(p_workspace_id, p_actor) AND drive_viewable_by(t.id, p_actor)
  ORDER BY t.name LIMIT 30;
$$;

CREATE TABLE IF NOT EXISTS public.agent_personal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 2000),
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES workspace_agents(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_personal_notes_owner ON agent_personal_notes (user_id, workspace_id, agent_id, created_at DESC);
ALTER TABLE agent_personal_notes ENABLE ROW LEVEL SECURITY;
-- Private to their owner. Workspace admins have no access; retrieval never reads them.
DROP POLICY IF EXISTS "agent_personal_notes_own_read" ON agent_personal_notes;
CREATE POLICY "agent_personal_notes_own_read" ON agent_personal_notes FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS "agent_personal_notes_own_delete" ON agent_personal_notes;
CREATE POLICY "agent_personal_notes_own_delete" ON agent_personal_notes FOR DELETE TO authenticated
  USING (user_id = auth.uid());
REVOKE INSERT, UPDATE ON agent_personal_notes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.agent_save_personal_note(p_run_id uuid, p_content text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_run agent_runs%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000'; END IF;
  IF (SELECT count(*) FROM agent_personal_notes WHERE user_id = v_run.requested_by AND agent_id = v_run.agent_id) >= 200 THEN
    RAISE EXCEPTION 'You have 200 saved notes with this agent; delete some first' USING ERRCODE = '53400';
  END IF;
  INSERT INTO agent_personal_notes (workspace_id, user_id, agent_id, content, run_id)
  VALUES (v_run.workspace_id, v_run.requested_by, v_run.agent_id, btrim(p_content), p_run_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.agent_personal_notes_for(p_run_id uuid, p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid, content text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT n.id, n.content, n.created_at FROM agent_runs r
  JOIN agent_personal_notes n ON n.user_id = r.requested_by AND n.workspace_id = r.workspace_id AND n.agent_id = r.agent_id
  WHERE r.id = p_run_id AND user_is_workspace_member(r.workspace_id, r.requested_by)
  ORDER BY n.created_at DESC LIMIT least(greatest(p_limit, 1), 200);
$$;

-- Vetted, read-only aggregates over what the run's requester can see. The
-- records counted are recorded as run sources so sharing a result is
-- checked against the people who would see it.
CREATE OR REPLACE FUNCTION public.agent_workspace_metrics(p_run_id uuid, p_metric text, p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_run agent_runs%ROWTYPE; v_actor uuid; v_ws uuid; v_rows jsonb; v_from timestamptz; v_to timestamptz;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000'; END IF;
  v_actor := v_run.requested_by; v_ws := v_run.workspace_id;
  v_from := coalesce(p_from, now() - interval '30 days'); v_to := coalesce(p_to, now());
  IF v_to <= v_from OR v_to - v_from > interval '400 days' THEN
    RAISE EXCEPTION 'Use a date range of up to 400 days' USING ERRCODE = '22023';
  END IF;

  IF p_metric IN ('tasks_by_status', 'tasks_by_assignee', 'tasks_by_project', 'tasks_completed_per_week', 'tasks_overdue') THEN
    CREATE TEMP TABLE IF NOT EXISTS pg_temp.metric_tasks (id uuid PRIMARY KEY, title text) ON COMMIT DROP;
    DELETE FROM pg_temp.metric_tasks;
    INSERT INTO pg_temp.metric_tasks
    SELECT t.id, t.title FROM tasks t
    WHERE t.workspace_id = v_ws AND t.deleted_at IS NULL AND task_visible_to(t.id, v_actor)
      AND (p_metric IN ('tasks_by_status', 'tasks_by_assignee', 'tasks_by_project', 'tasks_overdue')
           OR (t.status = 'completed' AND t.updated_at >= v_from AND t.updated_at < v_to))
    LIMIT 5000;
    INSERT INTO agent_run_sources (run_id, workspace_id, kind, ref_id, label)
    SELECT p_run_id, v_ws, 'task', m.id::text, left(m.title, 200) FROM pg_temp.metric_tasks m
    ON CONFLICT (run_id, kind, ref_id) DO NOTHING;

    IF p_metric = 'tasks_by_status' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', n) ORDER BY n DESC), '[]') INTO v_rows
      FROM (SELECT t.status, count(*) n FROM tasks t JOIN pg_temp.metric_tasks m ON m.id = t.id GROUP BY t.status) x;
    ELSIF p_metric = 'tasks_by_assignee' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('assignee', who, 'open', open_n, 'completed', done_n) ORDER BY open_n DESC), '[]') INTO v_rows
      FROM (SELECT coalesce(pr.display_name, pr.username, 'Unassigned') who,
                   count(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled')) open_n,
                   count(*) FILTER (WHERE t.status = 'completed') done_n
            FROM tasks t JOIN pg_temp.metric_tasks m ON m.id = t.id
            LEFT JOIN task_assignees ta ON ta.task_id = t.id LEFT JOIN profiles pr ON pr.id = ta.user_id
            GROUP BY 1) x;
    ELSIF p_metric = 'tasks_by_project' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('project', project, 'open', open_n, 'completed', done_n) ORDER BY open_n DESC), '[]') INTO v_rows
      FROM (SELECT coalesce(p.name, 'No project') project,
                   count(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled')) open_n,
                   count(*) FILTER (WHERE t.status = 'completed') done_n
            FROM tasks t JOIN pg_temp.metric_tasks m ON m.id = t.id LEFT JOIN projects p ON p.id = t.project_id
            GROUP BY 1) x;
    ELSIF p_metric = 'tasks_overdue' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('title', t.title, 'due', t.due_date::date, 'status', t.status) ORDER BY t.due_date), '[]')
      INTO v_rows
      FROM tasks t JOIN pg_temp.metric_tasks m ON m.id = t.id
      WHERE t.due_date < now() AND t.status NOT IN ('completed', 'cancelled');
    ELSE
      SELECT coalesce(jsonb_agg(jsonb_build_object('week', wk, 'completed', n) ORDER BY wk), '[]') INTO v_rows
      FROM (SELECT date_trunc('week', t.updated_at)::date wk, count(*) n FROM tasks t JOIN pg_temp.metric_tasks m ON m.id = t.id GROUP BY 1) x;
    END IF;

  ELSIF p_metric = 'messages_per_channel' THEN
    INSERT INTO agent_run_sources (run_id, workspace_id, kind, ref_id, channel_id, label)
    SELECT p_run_id, v_ws, 'channel', c.id::text, c.id, '#' || c.name FROM channels c
    WHERE c.workspace_id = v_ws AND user_is_channel_member(c.id, v_actor)
    ON CONFLICT (run_id, kind, ref_id) DO NOTHING;
    SELECT coalesce(jsonb_agg(jsonb_build_object('channel', name, 'messages', n) ORDER BY n DESC), '[]') INTO v_rows
    FROM (SELECT CASE WHEN EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.channel_id = c.id) THEN 'Direct messages'
                      ELSE '#' || c.name END name, count(m.id) n
          FROM channels c JOIN messages m ON m.channel_id = c.id
          WHERE c.workspace_id = v_ws AND user_is_channel_member(c.id, v_actor) AND m.deleted_at IS NULL
            AND m.created_at >= v_from AND m.created_at < v_to
          GROUP BY 1) x;

  ELSIF p_metric IN ('deals_by_stage', 'contacts_by_lifecycle') THEN
    IF to_regclass('public.crm_deals') IS NULL THEN RAISE EXCEPTION 'The CRM is not set up' USING ERRCODE = '55000'; END IF;
    IF p_metric = 'deals_by_stage' THEN
      -- Values are summed per currency; currencies are never mixed.
      EXECUTE $q$
        SELECT coalesce(jsonb_agg(jsonb_build_object('pipeline', pipeline, 'stage', stage, 'currency', currency, 'deals', n, 'total_value', total)
               ORDER BY pipeline, position, currency), '[]')
        FROM (SELECT pl.name pipeline, st.name stage, st.position, d.currency, count(*) n, sum(d.value) total
              FROM crm_deals d JOIN crm_stages st ON st.id = d.stage_id JOIN crm_pipelines pl ON pl.id = d.pipeline_id
              WHERE d.workspace_id = $1 GROUP BY 1, 2, 3, 4) x$q$ INTO v_rows USING v_ws;
    ELSE
      EXECUTE $q$
        SELECT coalesce(jsonb_agg(jsonb_build_object('lifecycle_stage', lifecycle_stage, 'contacts', n) ORDER BY n DESC), '[]')
        FROM (SELECT lifecycle_stage, count(*) n FROM crm_contacts WHERE workspace_id = $1 GROUP BY 1) x$q$ INTO v_rows USING v_ws;
    END IF;
    INSERT INTO agent_run_sources (run_id, workspace_id, kind, ref_id, label)
    VALUES (p_run_id, v_ws, 'crm_record', 'aggregate:' || p_metric, 'CRM ' || replace(p_metric, '_', ' '))
    ON CONFLICT (run_id, kind, ref_id) DO NOTHING;
  ELSE
    RAISE EXCEPTION 'Unsupported metric %', p_metric USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('metric', p_metric, 'from', v_from, 'to', v_to, 'rows', v_rows,
    'scope', 'Only records the requester can see are counted.');
END $$;

-- ---------------------------------------------------------------------------
-- Directory, timeline and history
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.agent_directory(uuid);
CREATE FUNCTION public.agent_directory(p_workspace_id uuid)
RETURNS TABLE(id uuid, template_key text, name text, handle text, description text, category text, color text, icon text,
  visibility text, status text, is_builtin boolean, created_by uuid, version_no integer, model text, effort text, tools text[],
  source_scope jsonb, job text, capability text, examples text[], requires text[], scoped_sources integer, ready_sources integer,
  kind text, connectors text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT a.id, a.template_key, a.name, a.handle, a.description, a.category, a.color, a.icon, a.visibility, a.status, a.is_builtin,
    a.created_by, v.version_no, v.model, v.effort, v.tools, v.source_scope, t.job, t.capability, coalesce(t.examples, '{}'),
    coalesce(t.requires, '{}'),
    coalesce(jsonb_array_length(v.source_scope -> 'item_ids'), 0),
    (SELECT count(*)::integer FROM knowledge_sources s
     WHERE s.status = 'ready' AND s.superseded_at IS NULL
       AND s.item_id IN (SELECT x::uuid FROM jsonb_array_elements_text(coalesce(v.source_scope -> 'item_ids', '[]')) x)),
    coalesce(t.kind, 'specialist'), coalesce(t.connectors, '{}')
  FROM workspace_agents a
  JOIN workspace_agent_versions v ON v.id = a.current_version_id
  LEFT JOIN agent_templates t ON t.key = a.template_key
  WHERE a.workspace_id = p_workspace_id AND a.archived_at IS NULL AND agent_visible_to(a.id, auth.uid())
  ORDER BY a.is_builtin DESC, coalesce(t.sort_order, 1000), a.name;
$$;

DROP FUNCTION IF EXISTS public.agent_conversation_timeline(uuid);
CREATE FUNCTION public.agent_conversation_timeline(p_conversation_id uuid)
RETURNS TABLE(id uuid, role text, content text, status text, run_id uuid, branch_of uuid, scope jsonb, created_at timestamptz,
  redacted boolean, kind text, agent_id uuid, agent_name text, parent_run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT t.id, t.role,
    CASE WHEN t.hidden THEN 'This answer used sources you can no longer open, so it is hidden.' ELSE t.content END,
    t.status, t.run_id, t.branch_of, t.scope, t.created_at, t.hidden, t.kind, r.agent_id, a.name, r.parent_run_id
  FROM (
    SELECT m.*, (m.role = 'assistant' AND (
        EXISTS (SELECT 1 FROM agent_citations c WHERE c.message_id = m.id AND NOT drive_viewable_by(c.item_id, auth.uid()))
        OR NOT agent_run_sources_visible(m.run_id, auth.uid()))) AS hidden
    FROM agent_messages m JOIN agent_conversations cv ON cv.id = m.conversation_id
    WHERE m.conversation_id = p_conversation_id AND cv.created_by = auth.uid()
      AND user_is_workspace_member(cv.workspace_id, auth.uid())
  ) t
  LEFT JOIN agent_runs r ON r.id = t.run_id
  LEFT JOIN agent_runs pr ON pr.id = r.parent_run_id
  LEFT JOIN workspace_agents a ON a.id = r.agent_id
  -- Turn by turn: the prompt, then specialists' work (team runs), then the answer.
  ORDER BY coalesce(pr.created_at, r.created_at, t.created_at),
    CASE WHEN t.kind = 'delegation' THEN 1 WHEN t.role = 'user' THEN 0 ELSE 2 END,
    t.created_at, CASE t.role WHEN 'user' THEN 0 ELSE 1 END;
$$;

-- Team conversations replay only the top-level turns; specialists' work
-- reaches the coordinator through tool results.
CREATE OR REPLACE FUNCTION public.agent_history_for(p_run_id uuid, p_limit integer DEFAULT 24)
RETURNS TABLE(role text, content text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT h.role, h.content, h.created_at FROM (
    SELECT m.role, m.content, m.created_at, CASE m.role WHEN 'user' THEN 0 ELSE 1 END AS ord
    FROM agent_runs r
    JOIN agent_messages m ON m.conversation_id = r.conversation_id AND m.run_id IS DISTINCT FROM r.id
    WHERE r.id = p_run_id
      AND r.parent_run_id IS NULL
      AND m.kind = 'chat'
      AND m.created_at <= r.created_at
      AND length(btrim(m.content)) > 0
      AND (m.role = 'user' OR (
        m.status IN ('complete', 'interrupted', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM agent_citations c WHERE c.message_id = m.id AND NOT drive_viewable_by(c.item_id, r.requested_by))
        AND agent_run_sources_visible(m.run_id, r.requested_by)))
    ORDER BY m.created_at DESC, ord DESC
    LIMIT least(greatest(p_limit, 0), 60)
  ) h ORDER BY h.created_at, h.ord;
$$;

-- Mentions only reach active, non-archived specialists.
CREATE OR REPLACE FUNCTION public.agent_mention_targets(p_actor uuid, p_message_id uuid)
RETURNS TABLE(agent_id uuid, handle text, agent_name text, workspace_id uuid, channel_id uuid, thread_root_id uuid,
  content text, is_direct boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_msg messages%ROWTYPE;
BEGIN
  SELECT * INTO v_msg FROM messages WHERE id = p_message_id;
  IF v_msg.id IS NULL OR v_msg.user_id IS DISTINCT FROM p_actor OR v_msg.agent_id IS NOT NULL OR v_msg.deleted_at IS NOT NULL
     OR v_msg.created_at < now() - interval '15 minutes' OR NOT user_is_channel_member(v_msg.channel_id, p_actor) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id, a.handle, a.name, v_msg.workspace_id, v_msg.channel_id, coalesce(v_msg.parent_id, v_msg.id), v_msg.content,
    EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.channel_id = v_msg.channel_id)
  FROM (
    SELECT DISTINCT lower(m[1]) AS h
    FROM regexp_matches(coalesce(v_msg.content, ''), '(?:^|[^A-Za-z0-9_.-])@([A-Za-z][A-Za-z0-9-]{2,39})', 'g') AS m
  ) mentions
  JOIN workspace_agents a ON a.workspace_id = v_msg.workspace_id AND a.handle = mentions.h
  LEFT JOIN agent_templates tp ON tp.key = a.template_key
  WHERE a.status = 'active' AND a.archived_at IS NULL AND coalesce(tp.kind, 'specialist') = 'specialist'
    AND agent_visible_to(a.id, p_actor)
  ORDER BY a.handle
  LIMIT 3;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.agent_seed_workspace(uuid, uuid)', 'public.agent_delegate(uuid, jsonb)', 'public.agent_settle_team_task(uuid)',
    'public.agent_claim_run(uuid, text)', 'public.agent_recover_stale_runs()',
    'public.agent_finish_run(uuid, text, text, text, jsonb, text, text)', 'public.agent_action_audience(uuid, uuid, text, jsonb)',
    'public.agent_create_proposal(uuid, text, text, jsonb, text)', 'public.agent_execute_proposal(uuid)',
    'public.agent_calendar_for(uuid, uuid, timestamptz, timestamptz)', 'public.agent_brand_kit_items_for(uuid, uuid)',
    'public.agent_save_personal_note(uuid, text)', 'public.agent_personal_notes_for(uuid, integer)',
    'public.agent_workspace_metrics(uuid, text, timestamptz, timestamptz)', 'public.agent_history_for(uuid, integer)',
    'public.agent_mention_targets(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.ensure_workspace_agents(uuid)', 'public.ai_update_settings(uuid, jsonb)', 'public.agent_cancel_run(uuid)',
    'public.agent_directory(uuid)', 'public.agent_conversation_timeline(uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.agent_execute_proposal_core(uuid) TO service_role;

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_team_tasks; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
