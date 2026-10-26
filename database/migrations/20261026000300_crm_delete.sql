-- ============================================================================
-- 20261026000300_crm_delete.sql
-- ----------------------------------------------------------------------------
-- Workspace admins can delete CRM companies, contacts and deals. A deleted
-- company's contacts and deals stay, unlinked from it; its resource links go;
-- its Drive folder and brand task are kept. A client company whose own CRM
-- still has records cannot be deleted until those are removed.
-- ============================================================================

-- Re-point the record references so a delete unlinks instead of failing.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND cardinality(c.conkey) = 2
       AND c.conrelid::regclass::text IN ('crm_contacts', 'crm_deals', 'crm_links')
       AND c.confrelid::regclass::text IN ('crm_companies', 'crm_contacts', 'crm_deals')
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_company_fkey
  FOREIGN KEY (company_id, workspace_id) REFERENCES crm_companies(id, workspace_id) ON DELETE SET NULL (company_id);
ALTER TABLE crm_deals ADD CONSTRAINT crm_deals_company_fkey
  FOREIGN KEY (company_id, workspace_id) REFERENCES crm_companies(id, workspace_id) ON DELETE SET NULL (company_id);
ALTER TABLE crm_deals ADD CONSTRAINT crm_deals_contact_fkey
  FOREIGN KEY (contact_id, workspace_id) REFERENCES crm_contacts(id, workspace_id) ON DELETE SET NULL (contact_id);
ALTER TABLE crm_links ADD CONSTRAINT crm_links_company_fkey
  FOREIGN KEY (company_id, workspace_id) REFERENCES crm_companies(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE crm_links ADD CONSTRAINT crm_links_contact_fkey
  FOREIGN KEY (contact_id, workspace_id) REFERENCES crm_contacts(id, workspace_id) ON DELETE CASCADE;
ALTER TABLE crm_links ADD CONSTRAINT crm_links_deal_fkey
  FOREIGN KEY (deal_id, workspace_id) REFERENCES crm_deals(id, workspace_id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.crm_before_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'crm_companies' AND OLD.is_client AND (
     EXISTS (SELECT 1 FROM crm_companies WHERE client_id = OLD.id) OR EXISTS (SELECT 1 FROM crm_contacts WHERE client_id = OLD.id)
     OR EXISTS (SELECT 1 FROM crm_deals WHERE client_id = OLD.id)) THEN
    RAISE EXCEPTION '% still has records in its own CRM. Delete those first.', OLD.name USING ERRCODE = '23503';
  END IF;
  INSERT INTO crm_activity (workspace_id, record_type, record_id, actor_id, action, changes)
  VALUES (OLD.workspace_id, TG_TABLE_NAME, OLD.id, auth.uid(), 'delete', jsonb_build_object('name', OLD.name));
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (OLD.workspace_id, auth.uid(), 'crm_delete', TG_TABLE_NAME, OLD.id, jsonb_build_object('name', OLD.name));
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.crm_before_delete() FROM PUBLIC, anon, authenticated;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm_companies', 'crm_contacts', 'crm_deals'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_delete ON %I', t);
    EXECUTE format('CREATE POLICY admin_delete ON %I FOR DELETE TO authenticated USING (user_is_workspace_admin(workspace_id, auth.uid()))', t);
    EXECUTE format('DROP TRIGGER IF EXISTS before_delete ON %I', t);
    EXECUTE format('CREATE TRIGGER before_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.crm_before_delete()', t);
    EXECUTE format('GRANT DELETE ON %I TO authenticated', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
