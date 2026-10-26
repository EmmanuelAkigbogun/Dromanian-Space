-- ============================================================================
-- 20261026000100_crm_client_books.sql
-- ----------------------------------------------------------------------------
-- Separate CRMs per client. A company in our CRM can be marked as a client
-- (is_client); it then has its own contacts, companies and deals, kept apart
-- from ours (client_id points at the client). Records never link across
-- CRMs, and companies inside a client's CRM get no Drive folder or
-- brand-files task — only our own companies (including the clients) do.
-- ============================================================================

ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS is_client boolean NOT NULL DEFAULT false;
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES crm_companies(id);
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES crm_companies(id);
ALTER TABLE crm_deals ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES crm_companies(id);
CREATE INDEX IF NOT EXISTS idx_crm_companies_client ON crm_companies (workspace_id, client_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_client ON crm_contacts (workspace_id, client_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_client ON crm_deals (workspace_id, client_id);

-- The CRM a company or contact belongs to (NULL = ours).
CREATE OR REPLACE FUNCTION public.crm_book_of(p_table text, p_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE p_table
    WHEN 'company' THEN (SELECT client_id FROM crm_companies WHERE id = p_id)
    WHEN 'contact' THEN (SELECT client_id FROM crm_contacts WHERE id = p_id)
  END;
$$;

CREATE OR REPLACE FUNCTION public.crm_check_client_book() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_client crm_companies%ROWTYPE;
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    SELECT * INTO v_client FROM crm_companies WHERE id = NEW.client_id;
    IF v_client.id IS NULL OR v_client.workspace_id <> NEW.workspace_id OR NOT v_client.is_client OR v_client.client_id IS NOT NULL THEN
      RAISE EXCEPTION 'Choose a client CRM from this workspace' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'crm_companies' THEN
    IF NEW.client_id = NEW.id THEN RAISE EXCEPTION 'A company cannot be its own client CRM' USING ERRCODE = '22023'; END IF;
    IF NEW.is_client AND NEW.client_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only companies in our own CRM can have a client CRM' USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.is_client AND NOT NEW.is_client AND (
       EXISTS (SELECT 1 FROM crm_companies WHERE client_id = NEW.id) OR EXISTS (SELECT 1 FROM crm_contacts WHERE client_id = NEW.id)
       OR EXISTS (SELECT 1 FROM crm_deals WHERE client_id = NEW.id)) THEN
      RAISE EXCEPTION 'This client CRM still has records' USING ERRCODE = '22023';
    END IF;
  ELSIF TG_TABLE_NAME = 'crm_contacts' THEN
    IF NEW.company_id IS NOT NULL AND crm_book_of('company', NEW.company_id) IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'The company belongs to a different CRM' USING ERRCODE = '22023';
    END IF;
  ELSIF TG_TABLE_NAME = 'crm_deals' THEN
    IF (NEW.company_id IS NOT NULL AND crm_book_of('company', NEW.company_id) IS DISTINCT FROM NEW.client_id)
       OR (NEW.contact_id IS NOT NULL AND crm_book_of('contact', NEW.contact_id) IS DISTINCT FROM NEW.client_id) THEN
      RAISE EXCEPTION 'The company or contact belongs to a different CRM' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_crm_companies_client_book ON crm_companies;
CREATE TRIGGER trg_crm_companies_client_book BEFORE INSERT OR UPDATE OF client_id, is_client ON crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.crm_check_client_book();
DROP TRIGGER IF EXISTS trg_crm_contacts_client_book ON crm_contacts;
CREATE TRIGGER trg_crm_contacts_client_book BEFORE INSERT OR UPDATE OF client_id, company_id ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.crm_check_client_book();
DROP TRIGGER IF EXISTS trg_crm_deals_client_book ON crm_deals;
CREATE TRIGGER trg_crm_deals_client_book BEFORE INSERT OR UPDATE OF client_id, company_id, contact_id ON crm_deals
  FOR EACH ROW EXECUTE FUNCTION public.crm_check_client_book();

-- Folder + brand-files task only for companies in our own CRM.
CREATE OR REPLACE FUNCTION public.crm_company_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_parent uuid; v_folder uuid; v_task uuid;
BEGIN
  IF NEW.client_id IS NOT NULL THEN RETURN NEW; END IF;

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

REVOKE EXECUTE ON FUNCTION public.crm_book_of(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_check_client_book() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crm_company_setup() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
