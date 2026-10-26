-- ============================================================================
-- 20261026000500_crm_import.sql
-- ----------------------------------------------------------------------------
-- Bulk import of companies or contacts (from an uploaded or Drive CSV/Excel
-- file) into one CRM: ours or a client's. Runs as the caller, so row-level
-- security and every record trigger apply. Duplicates are skipped: companies
-- by name, contacts by email, within that CRM. Contacts are linked to a
-- company of the same CRM by name, created when missing if asked.
--
-- Companies imported into our own CRM get a Drive folder and brand-files task
-- only when p_setup is true; crm_company_setup honours crm.skip_setup.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.crm_company_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_parent uuid; v_folder uuid; v_task uuid;
BEGIN
  IF NEW.client_id IS NOT NULL OR current_setting('crm.skip_setup', true) = 'on' THEN RETURN NEW; END IF;

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
REVOKE EXECUTE ON FUNCTION public.crm_company_setup() FROM PUBLIC, anon, authenticated;

-- p_rows: [{name, domain, industry, phone, email, notes, title, company,
-- lifecycle_stage, tags: [..], custom: {..}}, ...]; unknown keys are ignored.
CREATE OR REPLACE FUNCTION public.crm_import(
  p_workspace_id uuid, p_client_id uuid, p_kind text, p_rows jsonb,
  p_setup boolean DEFAULT false, p_create_companies boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid(); r jsonb; v_name text; v_email text; v_company uuid; v_company_name text;
  v_created integer := 0; v_skipped integer := 0; v_companies integer := 0; v_errors jsonb := '[]'; v_n integer := 0;
  v_custom jsonb;
BEGIN
  IF v_uid IS NULL OR NOT user_is_workspace_member(p_workspace_id, v_uid) THEN RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '42501'; END IF;
  IF p_kind NOT IN ('companies', 'contacts') THEN RAISE EXCEPTION 'Import companies or contacts' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN RAISE EXCEPTION 'Import up to 5,000 rows at a time' USING ERRCODE = '22023'; END IF;
  IF NOT p_setup THEN PERFORM set_config('crm.skip_setup', 'on', true); END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_n := v_n + 1;
    v_name := left(btrim(coalesce(r ->> 'name', '')), 200);
    v_custom := CASE WHEN jsonb_typeof(r -> 'custom') = 'object' THEN r -> 'custom' ELSE '{}' END;
    IF v_name = '' THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
    BEGIN
      IF p_kind = 'companies' THEN
        IF EXISTS (SELECT 1 FROM crm_companies WHERE workspace_id = p_workspace_id AND client_id IS NOT DISTINCT FROM p_client_id AND lower(name) = lower(v_name)) THEN
          v_skipped := v_skipped + 1; CONTINUE;
        END IF;
        INSERT INTO crm_companies (workspace_id, client_id, name, domain, industry, phone, email, notes, custom, owner_id, created_by)
        VALUES (p_workspace_id, p_client_id, v_name, nullif(left(btrim(r ->> 'domain'), 200), ''), nullif(left(btrim(r ->> 'industry'), 100), ''),
                nullif(left(btrim(r ->> 'phone'), 50), ''), nullif(left(btrim(r ->> 'email'), 320), ''), left(coalesce(r ->> 'notes', ''), 20000),
                v_custom, v_uid, v_uid);
      ELSE
        v_email := nullif(lower(btrim(coalesce(r ->> 'email', ''))), '');
        IF v_email IS NOT NULL AND v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN v_email := NULL; END IF;
        IF v_email IS NOT NULL AND EXISTS (SELECT 1 FROM crm_contacts WHERE workspace_id = p_workspace_id AND client_id IS NOT DISTINCT FROM p_client_id AND lower(email) = v_email) THEN
          v_skipped := v_skipped + 1; CONTINUE;
        END IF;
        v_company := NULL;
        v_company_name := left(btrim(coalesce(r ->> 'company', '')), 200);
        IF v_company_name <> '' THEN
          SELECT id INTO v_company FROM crm_companies
           WHERE workspace_id = p_workspace_id AND client_id IS NOT DISTINCT FROM p_client_id AND lower(name) = lower(v_company_name) LIMIT 1;
          IF v_company IS NULL AND p_create_companies THEN
            INSERT INTO crm_companies (workspace_id, client_id, name, owner_id, created_by)
            VALUES (p_workspace_id, p_client_id, v_company_name, v_uid, v_uid) RETURNING id INTO v_company;
            v_companies := v_companies + 1;
          END IF;
        END IF;
        INSERT INTO crm_contacts (workspace_id, client_id, name, email, phone, title, company_id, lifecycle_stage, tags, notes, custom, owner_id, created_by)
        VALUES (p_workspace_id, p_client_id, v_name, v_email, nullif(left(btrim(r ->> 'phone'), 50), ''), nullif(left(btrim(r ->> 'title'), 200), ''),
                v_company, coalesce(nullif(btrim(r ->> 'lifecycle_stage'), ''), 'lead'),
                CASE WHEN jsonb_typeof(r -> 'tags') = 'array' THEN ARRAY(SELECT left(btrim(t), 50) FROM jsonb_array_elements_text(r -> 'tags') t WHERE btrim(t) <> '' LIMIT 20) ELSE '{}' END,
                left(coalesce(r ->> 'notes', ''), 20000), v_custom, v_uid, v_uid);
      END IF;
      v_created := v_created + 1;
    EXCEPTION WHEN others THEN
      IF jsonb_array_length(v_errors) < 20 THEN v_errors := v_errors || jsonb_build_object('row', v_n, 'error', SQLERRM); END IF;
      v_skipped := v_skipped + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped, 'companies_created', v_companies, 'errors', v_errors);
END $$;
REVOKE ALL ON FUNCTION public.crm_import(uuid, uuid, text, jsonb, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_import(uuid, uuid, text, jsonb, boolean, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
