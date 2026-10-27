-- Finish the coding-agent removal for state created before the roster change.
-- Replace the coordinator's untouched default version so it no longer
-- advertises or routes technical/coding work. Customized versions are kept.

DO $$
DECLARE
  coordinator record;
  next_version uuid;
  updated_instructions text;
BEGIN
  SELECT instructions INTO updated_instructions
  FROM public.agent_templates
  WHERE key = 'cerebras_coordinator';

  FOR coordinator IN
    SELECT agent.id, agent.workspace_id, agent.current_version_id,
           version.version_no, version.instructions, version.tools,
           version.source_scope, version.model, version.effort,
           version.max_tool_steps, version.created_by
    FROM public.workspace_agents agent
    JOIN public.workspace_agent_versions version ON version.id = agent.current_version_id
    WHERE agent.is_builtin
      AND agent.template_key = 'cerebras_coordinator'
      AND version.instructions LIKE '%no more than four focused tasks%'
  LOOP
    INSERT INTO public.workspace_agent_versions (
      agent_id, workspace_id, version_no, instructions, tools, source_scope,
      model, effort, max_tool_steps, created_by
    ) VALUES (
      coordinator.id, coordinator.workspace_id, coordinator.version_no + 1,
      updated_instructions, coordinator.tools, coordinator.source_scope,
      coordinator.model, coordinator.effort, coordinator.max_tool_steps,
      coordinator.created_by
    ) RETURNING id INTO next_version;

    UPDATE public.workspace_agents
    SET current_version_id = next_version, updated_at = now()
    WHERE id = coordinator.id;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
