-- Keep the workspace Gemini-only while allowing the runtime to fall back to
-- other stable Flash models when the primary model is temporarily overloaded.
-- Also add a general-purpose Gemini assistant to every workspace and make the
-- provider recorded on each run follow its model automatically.

INSERT INTO public.ai_models
  (id, provider, label, tier, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, sort_order, active)
VALUES
  ('gemini-3.8-flash',      'gemini', 'Gemini 3.8 Flash',      'standard', NULL, NULL, NULL, NULL, 70, true),
  ('gemini-3.6-flash',      'gemini', 'Gemini 3.6 Flash',      'standard', NULL, NULL, NULL, NULL, 71, true),
  ('gemini-3.5-flash-lite', 'gemini', 'Gemini 3.5 Flash Lite', 'fast',     NULL, NULL, NULL, NULL, 72, true)
ON CONFLICT (id) DO UPDATE SET
  provider = EXCLUDED.provider,
  label = EXCLUDED.label,
  tier = EXCLUDED.tier,
  sort_order = EXCLUDED.sort_order,
  active = true,
  updated_at = now();

UPDATE public.workspace_ai_settings
SET default_model = 'gemini-3.8-flash',
    allowed_models = ARRAY['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']::text[],
    updated_at = now()
WHERE default_model IS DISTINCT FROM 'gemini-3.8-flash'
   OR allowed_models IS DISTINCT FROM ARRAY['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']::text[];

INSERT INTO public.agent_templates (
  key, name, handle, job, capability, category, description, instructions,
  default_tools, examples, color, icon, sort_order, requires, kind, connectors
)
VALUES (
  'gemini_assistant',
  'Gemini',
  'gemini',
  'General AI Assistant',
  'A flexible Gemini chatbot for questions, writing, planning, research and work across your workspace.',
  'General',
  'Your general-purpose Gemini assistant. It can answer directly, search information you can access, and prepare reviewed tasks, documents, messages and calendar events.',
  'You are Gemini, the workspace''s general-purpose AI assistant. Help with everyday questions, explanations, brainstorming, writing, summaries, planning and research. Start with a direct useful answer. Use workspace tools when the request depends on workspace facts, and cite file passages as [n]. Use web search only when it is enabled and current public information is needed; clearly distinguish web results from workspace facts. Never claim to have opened data you did not retrieve. When a person asks to create or change something, prepare the appropriate proposal for their review rather than claiming it was completed. Ask a short clarifying question only when the missing detail would materially change the result.',
  ARRAY[
    'search_workspace', 'search_knowledge', 'read_file', 'read_conversation',
    'list_tasks', 'read_calendar', 'workspace_metrics', 'read_brand_kit',
    'read_crm_record', 'compute_csv_metrics', 'web_search', 'fetch_site_page',
    'propose_task', 'propose_document', 'propose_channel_message',
    'propose_calendar_event', 'propose_crm_update'
  ],
  ARRAY[
    'Help me plan this week from my tasks and calendar.',
    'Summarize what our workspace knows about this customer.',
    'Research this topic and draft a short brief.'
  ],
  '#4285F4',
  'sparkles',
  10,
  '{}',
  'specialist',
  '{}'
)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  handle = EXCLUDED.handle,
  job = EXCLUDED.job,
  capability = EXCLUDED.capability,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  instructions = EXCLUDED.instructions,
  default_tools = EXCLUDED.default_tools,
  examples = EXCLUDED.examples,
  color = EXCLUDED.color,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order,
  requires = EXCLUDED.requires,
  kind = EXCLUDED.kind,
  connectors = EXCLUDED.connectors,
  retired = false;

DO $$
DECLARE workspace record;
BEGIN
  FOR workspace IN SELECT id FROM public.workspaces LOOP
    PERFORM public.agent_seed_workspace(workspace.id, NULL);
  END LOOP;
END $$;

-- A run used to inherit the table's historic "anthropic" default even when
-- its model was Gemini. Derive the provider at the database boundary so
-- dashboards, audit history and usage reporting remain truthful.
CREATE OR REPLACE FUNCTION public.agent_runs_set_provider()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.provider := public.ai_provider_of(NEW.model);
  IF NEW.provider IS NULL THEN
    RAISE EXCEPTION 'No provider is registered for model %', NEW.model USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agent_runs_set_provider ON public.agent_runs;
CREATE TRIGGER trg_agent_runs_set_provider
BEFORE INSERT OR UPDATE OF model ON public.agent_runs
FOR EACH ROW EXECUTE FUNCTION public.agent_runs_set_provider();

UPDATE public.agent_runs
SET provider = public.ai_provider_of(model)
WHERE provider IS DISTINCT FROM public.ai_provider_of(model)
  AND public.ai_provider_of(model) IS NOT NULL;

REVOKE ALL ON FUNCTION public.agent_runs_set_provider() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
