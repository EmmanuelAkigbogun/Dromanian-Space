-- Replace the legacy character-style roster with role-based Google ADK identities.
-- Agent UUIDs and conversation/run history stay intact. Handles are changed too so
-- the legacy names no longer appear in mentions or automation selectors.

CREATE TEMP TABLE _native_adk_agents (
  template_key text PRIMARY KEY,
  old_name text NOT NULL,
  native_name text NOT NULL,
  native_handle text NOT NULL
) ON COMMIT DROP;

INSERT INTO _native_adk_agents (template_key, old_name, native_name, native_handle) VALUES
  ('team_coordinator', 'Team Lead', 'Team Coordinator', 'team-coordinator'),
  ('growth_strategist', 'Atlas', 'Marketing Strategist', 'marketing-strategist'),
  ('support_specialist', 'Haven', 'Customer Support', 'customer-support'),
  ('commerce_manager', 'Marlo', 'Commerce Manager', 'commerce-manager'),
  ('data_analyst', 'Tally', 'Data Analyst', 'data-analyst'),
  ('email_marketer', 'Wren', 'Email Marketer', 'email-marketer'),
  ('personal_coach', 'Sage', 'Personal Coach', 'personal-coach'),
  ('sales_rep', 'Rio', 'Sales Development Representative', 'sales-development'),
  ('copywriter', 'Inka', 'Copywriter', 'copywriter'),
  ('recruiter', 'Talia', 'HR Assistant', 'hr-assistant'),
  ('seo_specialist', 'Orbit', 'SEO Specialist', 'seo-specialist'),
  ('social_manager', 'Echo', 'Social Media Manager', 'social-media-manager'),
  ('executive_assistant', 'Juno', 'Executive Assistant', 'executive-assistant'),
  ('business_researcher', 'Vera', 'Business Researcher', 'business-researcher'),
  ('creative_director', 'Nova', 'Creative Director', 'creative-director'),
  ('software_engineer', 'Kai', 'Software Engineer', 'software-engineer');

CREATE OR REPLACE FUNCTION pg_temp.native_adk_instructions(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(
           replace(replace(replace(replace(replace(replace(replace(replace(
             value,
             'Team Lead', 'Team Coordinator'),
             'Atlas', 'Marketing Strategist'),
             'Haven', 'Customer Support'),
             'Marlo', 'Commerce Manager'),
             'Tally', 'Data Analyst'),
             'Wren', 'Email Marketer'),
             'Sage', 'Personal Coach'),
             'Rio', 'Sales Development Representative'),
             'Inka', 'Copywriter'),
             'Talia', 'HR Assistant'),
             'Orbit', 'SEO Specialist'),
             'Echo', 'Social Media Manager'),
             'Juno', 'Executive Assistant'),
             'Vera', 'Business Researcher'),
             'Nova', 'Creative Director'),
             'Kai', 'Software Engineer');
$$;

UPDATE agent_templates template
SET name = mapping.native_name,
    handle = mapping.native_handle,
    instructions = pg_temp.native_adk_instructions(template.instructions)
FROM _native_adk_agents mapping
WHERE template.key = mapping.template_key;

DO $$
DECLARE
  item record;
  next_handle text;
  next_version_id uuid;
  next_version_no integer;
  next_instructions text;
BEGIN
  FOR item IN
    SELECT agent.id, agent.workspace_id, agent.template_key,
           mapping.native_name, mapping.native_handle,
           version.instructions, version.tools, version.source_scope,
           version.model, version.effort, version.max_tool_steps, version.created_by
    FROM workspace_agents agent
    JOIN _native_adk_agents mapping ON mapping.template_key = agent.template_key
    JOIN workspace_agent_versions version ON version.id = agent.current_version_id
    WHERE agent.is_builtin
  LOOP
    next_handle := item.native_handle;
    IF EXISTS (
      SELECT 1 FROM workspace_agents conflict
      WHERE conflict.workspace_id = item.workspace_id
        AND conflict.handle = next_handle
        AND conflict.id <> item.id
    ) THEN
      next_handle := next_handle || '-adk-' || left(item.id::text, 8);
    END IF;

    UPDATE workspace_agents
    SET name = item.native_name, handle = next_handle, updated_at = now()
    WHERE id = item.id;

    next_instructions := pg_temp.native_adk_instructions(item.instructions);
    IF next_instructions IS DISTINCT FROM item.instructions THEN
      SELECT coalesce(max(version_no), 0) + 1 INTO next_version_no
      FROM workspace_agent_versions
      WHERE agent_id = item.id;

      INSERT INTO workspace_agent_versions (
        agent_id, workspace_id, version_no, instructions, tools, source_scope,
        model, effort, max_tool_steps, created_by
      ) VALUES (
        item.id, item.workspace_id, next_version_no, next_instructions, item.tools,
        item.source_scope, item.model, item.effort, item.max_tool_steps, item.created_by
      ) RETURNING id INTO next_version_id;

      UPDATE workspace_agents
      SET current_version_id = next_version_id, updated_at = now()
      WHERE id = item.id;
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
