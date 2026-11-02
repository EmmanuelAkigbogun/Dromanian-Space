-- One-step API switch for the Agents page: an admin picks a provider's model
-- and every shared agent moves to it. In one transaction this allows the
-- model, makes it the workspace default and creates new agent versions
-- through ai_apply_model_to_agents (which keeps history and writes the audit
-- entry). Private custom agents are left to their creators.

CREATE OR REPLACE FUNCTION public.ai_use_model(p_workspace_id uuid, p_model text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_provider text := ai_provider_of(p_model);
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can change agent models' USING ERRCODE = '42501';
  END IF;
  IF v_provider IS NULL OR NOT EXISTS (SELECT 1 FROM ai_models WHERE id = p_model AND active) THEN
    RAISE EXCEPTION 'Model % is not in the model catalog', p_model USING ERRCODE = '22023';
  END IF;
  -- The server reports which providers have a key; refuse a switch that
  -- would leave every agent unable to run.
  IF NOT coalesce((SELECT (providers ->> v_provider)::boolean FROM ai_platform_state WHERE id), false) THEN
    RAISE EXCEPTION 'The % API has no key on this server', v_provider USING ERRCODE = '22023';
  END IF;
  PERFORM ai_settings_for(p_workspace_id);
  UPDATE workspace_ai_settings
  SET allowed_models = ARRAY(SELECT DISTINCT model FROM unnest(allowed_models || ARRAY[p_model]) AS model ORDER BY model),
      default_model = p_model,
      updated_at = now()
  WHERE workspace_id = p_workspace_id;
  RETURN ai_apply_model_to_agents(p_workspace_id, p_model);
END $$;

REVOKE ALL ON FUNCTION public.ai_use_model(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_use_model(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
