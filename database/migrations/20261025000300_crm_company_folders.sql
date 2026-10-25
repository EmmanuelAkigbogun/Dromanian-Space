-- ============================================================================
-- 20261025000300_crm_company_folders.sql
-- ----------------------------------------------------------------------------
-- Adding a CRM company creates its Drive folder (inside a shared "Companies"
-- folder the whole workspace can edit) and a task for the company owner to
-- upload the logo and brand identity files there. Both are linked to the
-- company record. Runs for every way a company is created.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.workspace_crm_folders (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (folder_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);
ALTER TABLE workspace_crm_folders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workspace_crm_folders_read" ON workspace_crm_folders;
CREATE POLICY "workspace_crm_folders_read" ON workspace_crm_folders FOR SELECT TO authenticated
  USING (public.user_is_workspace_member(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON workspace_crm_folders FROM anon, authenticated;

ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS drive_folder_id uuid;
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS brand_task_id uuid;

CREATE OR REPLACE FUNCTION public.crm_company_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_parent uuid; v_folder uuid; v_task uuid;
BEGIN
  -- The shared "Companies" folder, created once per workspace.
  SELECT f.folder_id INTO v_parent FROM workspace_crm_folders f
  JOIN drive_items i ON i.id = f.folder_id AND i.trashed_at IS NULL
  WHERE f.workspace_id = NEW.workspace_id;
  IF v_parent IS NULL THEN
    INSERT INTO drive_items (workspace_id, parent_id, kind, name, owner_id, created_by, updated_by, origin)
    VALUES (NEW.workspace_id, NULL, 'folder', 'Companies', NEW.created_by, NEW.created_by, NEW.created_by, 'upload')
    RETURNING id INTO v_parent;
    INSERT INTO drive_grants (workspace_id, item_id, principal_type, role, source, created_by)
    VALUES (NEW.workspace_id, v_parent, 'workspace', 'editor', 'manual', NEW.created_by)
    ON CONFLICT DO NOTHING;
    INSERT INTO workspace_crm_folders (workspace_id, folder_id) VALUES (NEW.workspace_id, v_parent)
    ON CONFLICT (workspace_id) DO UPDATE SET folder_id = EXCLUDED.folder_id;
  END IF;

  INSERT INTO drive_items (workspace_id, parent_id, kind, name, owner_id, created_by, updated_by, origin)
  VALUES (NEW.workspace_id, v_parent, 'folder', drive_clean_name(NEW.name), NEW.created_by, NEW.created_by, NEW.created_by, 'upload')
  RETURNING id INTO v_folder;

  INSERT INTO tasks (workspace_id, title, description, priority, created_by)
  VALUES (NEW.workspace_id, left('Add logo and brand identity files for ' || NEW.name, 300),
          'Upload the logo and brand identity files (brand guide, colors, fonts, templates) for ' || NEW.name
          || ' to its Drive folder: /drive/folder/' || v_folder,
          'medium', NEW.created_by)
  RETURNING id INTO v_task;
  INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES (v_task, NEW.owner_id, NEW.created_by) ON CONFLICT DO NOTHING;
  INSERT INTO task_activity (task_id, user_id, action, details)
  VALUES (v_task, NEW.created_by, 'created', jsonb_build_object('source', 'crm_company', 'company_id', NEW.id, 'folder_id', v_folder));

  INSERT INTO crm_links (workspace_id, company_id, item_id, created_by) VALUES (NEW.workspace_id, NEW.id, v_folder, NEW.created_by);
  INSERT INTO crm_links (workspace_id, company_id, task_id, created_by) VALUES (NEW.workspace_id, NEW.id, v_task, NEW.created_by);
  UPDATE crm_companies SET drive_folder_id = v_folder, brand_task_id = v_task WHERE id = NEW.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_crm_company_setup ON crm_companies;
CREATE TRIGGER trg_crm_company_setup AFTER INSERT ON crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.crm_company_setup();

REVOKE EXECUTE ON FUNCTION public.crm_company_setup() FROM PUBLIC, anon, authenticated;
GRANT SELECT ON workspace_crm_folders TO authenticated;

NOTIFY pgrst, 'reload schema';
