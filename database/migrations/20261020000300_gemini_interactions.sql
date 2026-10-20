-- Google retired Gemini 2.5 for new API consumers. Keep the old rows for
-- historical run references, but only offer models exposed by Interactions API.
UPDATE public.ai_models
SET active = false, updated_at = now()
WHERE provider = 'gemini';

INSERT INTO public.ai_models (
  id, provider, label, tier, input_per_mtok,
  output_per_mtok, cache_read_per_mtok,
  cache_write_per_mtok, sort_order, active
)
VALUES
  ('gemini-3.8-flash',       'gemini', 'Gemini 3.8 Flash',       'standard', NULL, NULL, NULL, NULL, 70, true),
  ('gemini-3.7-flash',       'gemini', 'Gemini 3.7 Flash',       'standard', NULL, NULL, NULL, NULL, 71, true),
  ('gemini-3.5-flash-lite',  'gemini', 'Gemini 3.5 Flash Lite',  'fast',     NULL, NULL, NULL, NULL, 72, true),
  ('gemini-3.1-pro-preview', 'gemini', 'Gemini 3.1 Pro Preview', 'frontier', NULL, NULL, NULL, NULL, 73, true)
ON CONFLICT (id) DO UPDATE SET
  provider = EXCLUDED.provider,
  label = EXCLUDED.label,
  tier = EXCLUDED.tier,
  input_per_mtok = EXCLUDED.input_per_mtok,
  output_per_mtok = EXCLUDED.output_per_mtok,
  cache_read_per_mtok = EXCLUDED.cache_read_per_mtok,
  cache_write_per_mtok = EXCLUDED.cache_write_per_mtok,
  sort_order = EXCLUDED.sort_order,
  active = EXCLUDED.active,
  updated_at = now();
