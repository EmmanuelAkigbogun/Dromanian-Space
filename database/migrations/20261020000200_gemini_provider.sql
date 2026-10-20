-- Add Google Gemini as a third server-side agent provider. The API key remains
-- outside PostgreSQL; only provider availability and selectable model ids are
-- stored here. This migration is additive and safe to re-run.

CREATE OR REPLACE FUNCTION public.ai_provider_of(p_model text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_model ~ '^claude-' THEN 'anthropic'
    WHEN p_model ~ '^(gpt-|o[0-9]|chatgpt-)' THEN 'openai'
    WHEN p_model ~ '^gemini-' THEN 'gemini'
    ELSE NULL
  END;
$$;

ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_provider_check;
ALTER TABLE public.ai_models
  ADD CONSTRAINT ai_models_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'gemini')) NOT VALID;
ALTER TABLE public.ai_models VALIDATE CONSTRAINT ai_models_provider_check;

INSERT INTO public.ai_models
  (id, provider, label, tier, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, sort_order)
VALUES
  ('gemini-pro-latest',   'gemini', 'Gemini Pro (latest)',   'frontier', NULL, NULL, NULL, NULL, 70),
  ('gemini-flash-latest', 'gemini', 'Gemini Flash (latest)', 'fast',     NULL, NULL, NULL, NULL, 71),
  ('gemini-2.5-pro',      'gemini', 'Gemini 2.5 Pro',        'frontier', NULL, NULL, NULL, NULL, 72),
  ('gemini-2.5-flash',    'gemini', 'Gemini 2.5 Flash',      'fast',     NULL, NULL, NULL, NULL, 73)
ON CONFLICT (id) DO UPDATE SET
  provider = EXCLUDED.provider,
  label = EXCLUDED.label,
  tier = EXCLUDED.tier,
  sort_order = EXCLUDED.sort_order;

CREATE OR REPLACE FUNCTION public.ai_report_platform(p_providers jsonb, p_default_model text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_provider text := ai_provider_of(p_default_model);
BEGIN
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'Unknown provider for model %', p_default_model USING ERRCODE = '22023';
  END IF;
  INSERT INTO ai_models (id, provider, label, sort_order)
  VALUES (p_default_model, v_provider, p_default_model, 150)
  ON CONFLICT (id) DO NOTHING;
  UPDATE ai_platform_state SET
    providers = jsonb_build_object(
      'anthropic', coalesce((p_providers ->> 'anthropic')::boolean, false),
      'openai', coalesce((p_providers ->> 'openai')::boolean, false),
      'gemini', coalesce((p_providers ->> 'gemini')::boolean, false)),
    default_model = p_default_model,
    reported_at = now()
  WHERE id;
  RETURN (SELECT to_jsonb(s) FROM ai_platform_state s WHERE id);
END $$;

CREATE OR REPLACE FUNCTION public.workspace_ai_settings_check_models() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.allowed_models) m WHERE ai_provider_of(m) IS NULL) THEN
    RAISE EXCEPTION 'Every allowed model must be an Anthropic, OpenAI, or Google Gemini model' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.ai_report_platform(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_report_platform(jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.workspace_ai_settings_check_models() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_provider_of(text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
