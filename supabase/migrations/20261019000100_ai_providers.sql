-- ============================================================================
-- 20261019000100_ai_providers.sql
-- ----------------------------------------------------------------------------
-- Two model providers (Anthropic and OpenAI) behind the same agent engine.
--   * ai_models: the model catalog with editable USD prices per million
--     tokens. NULL prices mean "unknown": costs are then not estimated, never
--     invented. Administrators update prices with SQL (Studio) as providers
--     change them.
--   * ai_platform_state: which providers the server has keys for and the
--     platform default model, reported by the API/worker at startup. New
--     workspaces start from it; existing workspaces keep their settings.
--   * Usage ledger rows get their provider and an estimated cost on insert;
--     existing rows are backfilled.
--   * ai_apply_model_to_agents: an admin switches every shared agent to one
--     model in one step (new immutable versions, history kept).
-- Additive only: no table, column or row is dropped.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ai_provider_of(p_model text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_model ~ '^claude-' THEN 'anthropic'
    WHEN p_model ~ '^(gpt-|o[0-9]|chatgpt-)' THEN 'openai'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------------
-- Model catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_models (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.-]{1,79}$'),
  provider text NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  label text NOT NULL,
  tier text NOT NULL DEFAULT 'standard' CHECK (tier IN ('frontier', 'standard', 'fast')),
  input_per_mtok numeric(10, 4) CHECK (input_per_mtok IS NULL OR input_per_mtok >= 0),
  output_per_mtok numeric(10, 4) CHECK (output_per_mtok IS NULL OR output_per_mtok >= 0),
  cache_read_per_mtok numeric(10, 4) CHECK (cache_read_per_mtok IS NULL OR cache_read_per_mtok >= 0),
  cache_write_per_mtok numeric(10, 4) CHECK (cache_write_per_mtok IS NULL OR cache_write_per_mtok >= 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider = ai_provider_of(id))
);
COMMENT ON TABLE public.ai_models IS
  'Models agents can use. Prices are USD per million tokens, used only to estimate costs; NULL means unknown.';

ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_models_read" ON ai_models;
CREATE POLICY "ai_models_read" ON ai_models FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON ai_models FROM anon, authenticated;

-- Anthropic list prices (cache reads 0.1x, 5-minute cache writes 1.25x input).
-- OpenAI prices are left unknown: set them from the provider's pricing page.
INSERT INTO ai_models (id, provider, label, tier, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, sort_order)
VALUES
  ('claude-opus-5-5',   'anthropic', 'Claude Opus 5.5',   'frontier', 4.00, 20.00, 0.20, 5.00,  10),
  ('claude-sonnet-5-5', 'anthropic', 'Claude Sonnet 5.5', 'standard', 2.00, 10.00, 0.20, 2.50,  20),
  ('claude-haiku-5-5',  'anthropic', 'Claude Haiku 5.5',  'fast',     0.10,  0.50, 0.01, 0.125, 30),
  ('claude-haiku-4-5',  'anthropic', 'Claude Haiku 4.5',  'fast',     1.00,  5.00, 0.10, 1.25,  40),
  -- Refusal fallbacks can be served by these; listed so their usage is priced.
  ('claude-opus-5',     'anthropic', 'Claude Opus 5',     'frontier', 5.00, 25.00, 0.50, 6.25,  90),
  ('claude-sonnet-5',   'anthropic', 'Claude Sonnet 5',   'standard', 2.00, 10.00, 0.20, 2.50,  91),
  ('gpt-5.6-sol',       'openai',    'GPT-5.6 Sol',       'frontier', NULL, NULL, NULL, NULL, 50),
  ('gpt-5.6-terra',     'openai',    'GPT-5.6 Terra',     'standard', NULL, NULL, NULL, NULL, 51),
  ('gpt-5.6-luna',      'openai',    'GPT-5.6 Luna',      'fast',     NULL, NULL, NULL, NULL, 52),
  ('gpt-5.4',           'openai',    'GPT-5.4',           'frontier', NULL, NULL, NULL, NULL, 60),
  ('gpt-5.4-mini',      'openai',    'GPT-5.4 mini',      'standard', NULL, NULL, NULL, NULL, 61),
  ('gpt-5.4-nano',      'openai',    'GPT-5.4 nano',      'fast',     NULL, NULL, NULL, NULL, 62)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label, tier = EXCLUDED.tier, sort_order = EXCLUDED.sort_order,
  -- Never overwrite prices an administrator has set.
  input_per_mtok = coalesce(ai_models.input_per_mtok, EXCLUDED.input_per_mtok),
  output_per_mtok = coalesce(ai_models.output_per_mtok, EXCLUDED.output_per_mtok),
  cache_read_per_mtok = coalesce(ai_models.cache_read_per_mtok, EXCLUDED.cache_read_per_mtok),
  cache_write_per_mtok = coalesce(ai_models.cache_write_per_mtok, EXCLUDED.cache_write_per_mtok);

-- Models already chosen by workspaces stay in the catalog (unpriced if unknown).
INSERT INTO ai_models (id, provider, label, sort_order)
SELECT DISTINCT m, ai_provider_of(m), m, 200
FROM (
  SELECT unnest(allowed_models) AS m FROM workspace_ai_settings
  UNION SELECT model FROM workspace_agent_versions
) s
WHERE ai_provider_of(m) IS NOT NULL AND m ~ '^[a-z0-9][a-z0-9.-]{1,79}$'
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Platform state reported by the server (no secrets: booleans and a model id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_platform_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  providers jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_model text NOT NULL DEFAULT 'claude-opus-5-5',
  reported_at timestamptz
);
INSERT INTO ai_platform_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE ai_platform_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_platform_state_read" ON ai_platform_state;
CREATE POLICY "ai_platform_state_read" ON ai_platform_state FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON ai_platform_state FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.ai_report_platform(p_providers jsonb, p_default_model text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_provider text := ai_provider_of(p_default_model);
BEGIN
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'Unknown provider for model %', p_default_model USING ERRCODE = '22023';
  END IF;
  -- A default model configured on the server joins the catalog (unpriced).
  INSERT INTO ai_models (id, provider, label, sort_order)
  VALUES (p_default_model, v_provider, p_default_model, 150)
  ON CONFLICT (id) DO NOTHING;
  UPDATE ai_platform_state SET
    providers = jsonb_build_object(
      'anthropic', coalesce((p_providers ->> 'anthropic')::boolean, false),
      'openai', coalesce((p_providers ->> 'openai')::boolean, false)),
    default_model = p_default_model,
    reported_at = now()
  WHERE id;
  RETURN (SELECT to_jsonb(s) FROM ai_platform_state s WHERE id);
END $$;

CREATE OR REPLACE FUNCTION public.ai_platform_default_model()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT default_model FROM ai_platform_state WHERE id), 'claude-opus-5-5');
$$;

-- Models a new workspace may use: active catalog models of configured
-- providers (before the server has reported, the original Claude set).
CREATE OR REPLACE FUNCTION public.ai_platform_allowed_models()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH configured AS (
    SELECT m.id, m.sort_order FROM ai_models m, ai_platform_state s
    WHERE s.id AND m.active AND coalesce((s.providers ->> m.provider)::boolean, false)
      AND m.sort_order < 90
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM configured) THEN
      ARRAY(SELECT DISTINCT x FROM (SELECT id AS x FROM configured UNION SELECT ai_platform_default_model()) u ORDER BY x)
    ELSE ARRAY['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']
  END;
$$;

ALTER TABLE workspace_ai_settings ALTER COLUMN default_model SET DEFAULT ai_platform_default_model();
ALTER TABLE workspace_ai_settings ALTER COLUMN allowed_models SET DEFAULT ai_platform_allowed_models();

-- Seeding helper (as in 20261004001300) except for the model fallback: new
-- workspaces are seeded before their settings row exists, so the platform
-- default (not a fixed Claude model) decides which model new agents use.
CREATE OR REPLACE FUNCTION public.agent_seed_workspace(p_workspace_id uuid, p_created_by uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE t agent_templates%ROWTYPE; v_agent uuid; v_version uuid; v_created integer := 0; v_model text;
BEGIN
  v_model := coalesce((SELECT default_model FROM workspace_ai_settings WHERE workspace_id = p_workspace_id), ai_platform_default_model());
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

-- Every allowed model must belong to a supported provider.
CREATE OR REPLACE FUNCTION public.workspace_ai_settings_check_models() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.allowed_models) m WHERE ai_provider_of(m) IS NULL) THEN
    RAISE EXCEPTION 'Every allowed model must be an Anthropic (claude-…) or OpenAI (gpt-…, o…) model' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_workspace_ai_settings_models ON workspace_ai_settings;
CREATE TRIGGER trg_workspace_ai_settings_models BEFORE INSERT OR UPDATE OF allowed_models ON workspace_ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.workspace_ai_settings_check_models();

-- ---------------------------------------------------------------------------
-- Cost estimation
-- ---------------------------------------------------------------------------
-- Served model ids can carry a snapshot suffix (gpt-5.4-2026-03-05): the
-- longest catalog id that prefixes it is the model. If that model has no
-- price the cost stays unknown; a shorter, priced id (gpt-5.4 for
-- gpt-5.4-mini-…) is never used instead.
CREATE OR REPLACE FUNCTION public.ai_estimate_cost(p_model text, p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH m AS (
    SELECT * FROM ai_models
    WHERE p_model = id OR p_model LIKE id || '-%'
    ORDER BY length(id) DESC
    LIMIT 1
  )
  SELECT CASE WHEN m.input_per_mtok IS NULL OR m.output_per_mtok IS NULL THEN NULL ELSE round((
      coalesce(p_input, 0) * m.input_per_mtok
    + coalesce(p_output, 0) * m.output_per_mtok
    + coalesce(p_cache_read, 0) * coalesce(m.cache_read_per_mtok, m.input_per_mtok)
    + coalesce(p_cache_write, 0) * coalesce(m.cache_write_per_mtok, m.input_per_mtok)
  ) / 1000000.0, 6) END
  FROM m;
$$;

CREATE OR REPLACE FUNCTION public.ai_usage_ledger_enrich() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.model IS NOT NULL THEN
    NEW.provider := coalesce(ai_provider_of(NEW.model), NEW.provider);
    IF NEW.kind IN ('usage', 'failure') AND NEW.cost_usd IS NULL THEN
      NEW.cost_usd := ai_estimate_cost(NEW.model, NEW.input_tokens, NEW.output_tokens, NEW.cache_read_tokens, NEW.cache_write_tokens);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ai_usage_ledger_enrich ON ai_usage_ledger;
CREATE TRIGGER trg_ai_usage_ledger_enrich BEFORE INSERT ON ai_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION public.ai_usage_ledger_enrich();

UPDATE ai_usage_ledger SET
  provider = coalesce(ai_provider_of(model), provider),
  cost_usd = coalesce(cost_usd, CASE WHEN kind IN ('usage', 'failure')
    THEN ai_estimate_cost(model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) END)
WHERE model IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_kind_window ON ai_usage_ledger (workspace_id, kind, created_at);

-- Spend per provider and model since a point in time (the API checks that the
-- caller is a workspace admin before calling it).
CREATE OR REPLACE FUNCTION public.ai_cost_summary(p_workspace_id uuid, p_since timestamptz DEFAULT date_trunc('month', now()))
RETURNS TABLE(provider text, model text, runs bigint, input_tokens bigint, output_tokens bigint,
              cache_read_tokens bigint, cache_write_tokens bigint, cost_usd numeric, unpriced_rows bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.provider, l.model, count(DISTINCT l.run_id), sum(l.input_tokens)::bigint, sum(l.output_tokens)::bigint,
         sum(l.cache_read_tokens)::bigint, sum(l.cache_write_tokens)::bigint, sum(l.cost_usd),
         count(*) FILTER (WHERE l.cost_usd IS NULL)
  FROM ai_usage_ledger l
  WHERE l.workspace_id = p_workspace_id AND l.kind IN ('usage', 'failure') AND l.created_at >= p_since
  GROUP BY l.provider, l.model
  ORDER BY sum(l.cost_usd) DESC NULLS LAST, l.model;
$$;

-- ---------------------------------------------------------------------------
-- Switch every shared agent to one model
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_apply_model_to_agents(p_workspace_id uuid, p_model text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_settings workspace_ai_settings%ROWTYPE; v_count integer := 0; a record; v_cur workspace_agent_versions%ROWTYPE; v_new uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can change agent models' USING ERRCODE = '42501';
  END IF;
  v_settings := ai_settings_for(p_workspace_id);
  IF NOT p_model = ANY(v_settings.allowed_models) THEN
    RAISE EXCEPTION 'Model % is not allowed in this workspace', p_model USING ERRCODE = '22023';
  END IF;
  -- Shared agents only: private custom agents belong to their creators.
  FOR a IN SELECT id, current_version_id FROM workspace_agents
           WHERE workspace_id = p_workspace_id AND archived_at IS NULL AND (is_builtin OR visibility = 'workspace')
           FOR UPDATE LOOP
    SELECT * INTO v_cur FROM workspace_agent_versions WHERE id = a.current_version_id;
    CONTINUE WHEN v_cur.id IS NULL OR v_cur.model = p_model;
    INSERT INTO workspace_agent_versions (agent_id, workspace_id, version_no, instructions, tools, source_scope, model, effort, max_tool_steps, created_by)
    VALUES (a.id, p_workspace_id, v_cur.version_no + 1, v_cur.instructions, v_cur.tools, v_cur.source_scope, p_model,
            v_cur.effort, v_cur.max_tool_steps, auth.uid())
    RETURNING id INTO v_new;
    UPDATE workspace_agents SET current_version_id = v_new, updated_at = now() WHERE id = a.id;
    v_count := v_count + 1;
  END LOOP;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, auth.uid(), 'agent_models_changed', 'workspace', p_workspace_id,
          jsonb_build_object('model', p_model, 'agents', v_count));
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges: catalog reads are open to members; everything else is either
-- service-only or checks the caller itself.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ai_report_platform(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_report_platform(jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.ai_cost_summary(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_cost_summary(uuid, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.ai_estimate_cost(text, bigint, bigint, bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_estimate_cost(text, bigint, bigint, bigint, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ai_usage_ledger_enrich() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_ai_settings_check_models() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_apply_model_to_agents(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_apply_model_to_agents(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_provider_of(text) TO anon, authenticated, service_role;
-- Supabase grants new functions to anon by default; these definer helpers are
-- for signed-in members and the server only.
REVOKE ALL ON FUNCTION public.ai_platform_default_model() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_platform_allowed_models() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_platform_default_model() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_platform_allowed_models() TO authenticated, service_role;
GRANT SELECT ON ai_models, ai_platform_state TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
