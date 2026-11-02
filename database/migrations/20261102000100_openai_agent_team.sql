-- Move the agent team from Cerebras gpt-oss-120b to OpenAI (ChatGPT)
-- gpt-6.1-sol. Every agent still on the Cerebras model gets a new immutable
-- version on gpt-6.1-sol, so earlier versions, conversations, runs and usage
-- stay readable. Agents an administrator already moved to another model are
-- left alone. The Cerebras model stays allowed so a workspace can switch back.
--
-- Prices are OpenAI list prices (USD per million tokens) from
-- developers.openai.com/api/docs/models, checked 2026-11-02. Cache writes are
-- left NULL, which prices them at the input rate.

INSERT INTO public.ai_models
  (id, provider, label, tier, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, sort_order)
VALUES
  ('gpt-6-astra',   'openai', 'GPT-6 Astra',   'frontier', 10.00, 50.00, 1.00, NULL, 44),
  ('gpt-6.1-sol',   'openai', 'GPT-6.1 Sol',   'frontier',  2.00, 10.00, 0.10, NULL, 45),
  ('gpt-6.1-terra', 'openai', 'GPT-6.1 Terra', 'standard',  1.00,  5.00, 0.05, NULL, 46),
  ('gpt-6-luna',    'openai', 'GPT-6 Luna',    'fast',      0.10,  0.50, 0.01, NULL, 47)
ON CONFLICT (id) DO UPDATE SET
  provider = EXCLUDED.provider,
  label = EXCLUDED.label,
  tier = EXCLUDED.tier,
  sort_order = EXCLUDED.sort_order,
  active = true,
  -- Never overwrite prices an administrator has set.
  input_per_mtok = coalesce(ai_models.input_per_mtok, EXCLUDED.input_per_mtok),
  output_per_mtok = coalesce(ai_models.output_per_mtok, EXCLUDED.output_per_mtok),
  cache_read_per_mtok = coalesce(ai_models.cache_read_per_mtok, EXCLUDED.cache_read_per_mtok);

UPDATE public.agent_templates
SET default_model = 'gpt-6.1-sol'
WHERE NOT retired AND default_model = 'gpt-oss-120b';

UPDATE public.agent_templates
SET capability = 'Routes work to the right specialist and combines the results.'
WHERE key = 'cerebras_coordinator'
  AND capability = 'Routes work to the right Cerebras specialist and combines the results.';

-- Same as a new workspace on OpenAI: every GPT-6 model can be chosen.
UPDATE public.workspace_ai_settings settings
SET allowed_models = ARRAY(
      SELECT DISTINCT model
      FROM unnest(settings.allowed_models || ARRAY['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']::text[]) AS model
      ORDER BY model
    ),
    default_model = CASE WHEN settings.default_model = 'gpt-oss-120b' THEN 'gpt-6.1-sol' ELSE settings.default_model END,
    updated_at = now()
WHERE settings.default_model = 'gpt-oss-120b'
   OR NOT settings.allowed_models @> ARRAY['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']::text[];

DO $$
DECLARE agent record; next_version uuid;
BEGIN
  FOR agent IN
    SELECT workspace_agent.id, workspace_agent.workspace_id, version.instructions, version.tools,
           version.source_scope, version.effort, version.max_tool_steps, version.created_by,
           (SELECT max(existing.version_no) FROM public.workspace_agent_versions existing
             WHERE existing.agent_id = workspace_agent.id) AS last_version_no
    FROM public.workspace_agents workspace_agent
    JOIN public.workspace_agent_versions version ON version.id = workspace_agent.current_version_id
    WHERE workspace_agent.archived_at IS NULL AND version.model = 'gpt-oss-120b'
  LOOP
    INSERT INTO public.workspace_agent_versions (
      agent_id, workspace_id, version_no, instructions, tools, source_scope,
      model, effort, max_tool_steps, created_by
    ) VALUES (
      agent.id, agent.workspace_id, agent.last_version_no + 1, agent.instructions, agent.tools,
      agent.source_scope, 'gpt-6.1-sol', agent.effort, agent.max_tool_steps, agent.created_by
    ) RETURNING id INTO next_version;
    UPDATE public.workspace_agents SET current_version_id = next_version, updated_at = now() WHERE id = agent.id;
  END LOOP;
END $$;

UPDATE public.workspace_agents agent
SET description = template.description, updated_at = now()
FROM public.agent_templates template
WHERE agent.is_builtin AND agent.template_key = template.key AND agent.archived_at IS NULL
  AND agent.description ~ 'Cerebras' AND template.description !~ 'Cerebras';

NOTIFY pgrst, 'reload schema';
