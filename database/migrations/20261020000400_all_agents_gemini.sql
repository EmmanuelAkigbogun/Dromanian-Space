-- Make Gemini the only selectable provider model for every workspace and move
-- every existing agent to an immutable Gemini-backed version. Previous agent
-- versions remain available for audit/history. This migration is idempotent.

INSERT INTO public.ai_models
  (id, provider, label, tier, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, sort_order, active)
VALUES
  ('gemini-3.8-flash', 'gemini', 'Gemini 3.8 Flash', 'standard', NULL, NULL, NULL, NULL, 70, true)
ON CONFLICT (id) DO UPDATE SET
  provider = EXCLUDED.provider,
  label = EXCLUDED.label,
  tier = EXCLUDED.tier,
  active = true;

UPDATE public.workspace_ai_settings
SET default_model = 'gemini-3.8-flash',
    allowed_models = ARRAY['gemini-3.8-flash']::text[],
    updated_at = now()
WHERE default_model IS DISTINCT FROM 'gemini-3.8-flash'
   OR allowed_models IS DISTINCT FROM ARRAY['gemini-3.8-flash']::text[];

WITH agents_to_migrate AS (
  SELECT
    a.id AS agent_id,
    a.workspace_id,
    v.instructions,
    v.tools,
    v.source_scope,
    v.effort,
    v.max_tool_steps,
    v.created_by,
    (SELECT coalesce(max(existing.version_no), 0) + 1
       FROM public.workspace_agent_versions existing
      WHERE existing.agent_id = a.id) AS next_version_no
  FROM public.workspace_agents a
  JOIN public.workspace_agent_versions v ON v.id = a.current_version_id
  WHERE v.model IS DISTINCT FROM 'gemini-3.8-flash'
), inserted_versions AS (
  INSERT INTO public.workspace_agent_versions (
    agent_id,
    workspace_id,
    version_no,
    instructions,
    tools,
    source_scope,
    model,
    effort,
    max_tool_steps,
    created_by
  )
  SELECT
    agent_id,
    workspace_id,
    next_version_no,
    instructions,
    tools,
    source_scope,
    'gemini-3.8-flash',
    effort,
    max_tool_steps,
    created_by
  FROM agents_to_migrate
  ON CONFLICT (agent_id, version_no) DO NOTHING
  RETURNING id, agent_id
)
UPDATE public.workspace_agents agent
SET current_version_id = version.id,
    updated_at = now()
FROM inserted_versions version
WHERE agent.id = version.agent_id;

NOTIFY pgrst, 'reload schema';
