-- Existing production workspaces can have archived built-ins whose historical
-- handles were renamed to descriptive role names. workspace_agents keeps a
-- workspace-wide handle uniqueness constraint, so those inert rows can block
-- a new GitHub-sourced replacement from being seeded. Preserve every row,
-- conversation and run, but give only conflicting archived built-ins a stable
-- tombstone handle before retrying the standard seeder.

UPDATE public.workspace_agents archived
SET handle = 'archived-' || left(replace(archived.id::text, '-', ''), 23),
    updated_at = now()
WHERE archived.is_builtin
  AND archived.archived_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.agent_templates active_template
    WHERE NOT active_template.retired
      AND active_template.handle = archived.handle
      AND active_template.key IS DISTINCT FROM archived.template_key
  );

DO $$
DECLARE workspace record;
BEGIN
  FOR workspace IN SELECT id FROM public.workspaces LOOP
    PERFORM public.agent_seed_workspace(workspace.id, NULL);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
