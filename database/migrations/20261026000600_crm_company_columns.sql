-- ============================================================================
-- 20261026000600_crm_company_columns.sql
-- ----------------------------------------------------------------------------
-- Company records carry the prospect-list columns the team works with:
-- Name, Email, Sector (industry), Phone number, Has LinkedIn?, Website
-- (domain), LinkedIn URL, Listed location, Prospect type, Contact status,
-- Contact source URL(s) and Location / LinkedIn source.
-- ============================================================================

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS has_linkedin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS listed_location text,
  ADD COLUMN IF NOT EXISTS prospect_type text,
  ADD COLUMN IF NOT EXISTS contact_status text,
  ADD COLUMN IF NOT EXISTS contact_sources text,
  ADD COLUMN IF NOT EXISTS location_source text;

ALTER TABLE crm_companies DROP CONSTRAINT IF EXISTS crm_companies_prospect_lengths;
ALTER TABLE crm_companies ADD CONSTRAINT crm_companies_prospect_lengths CHECK (
  length(coalesce(linkedin_url, '')) <= 500 AND length(coalesce(listed_location, '')) <= 200
  AND length(coalesce(prospect_type, '')) <= 100 AND length(coalesce(contact_status, '')) <= 100
  AND length(coalesce(contact_sources, '')) <= 2000 AND length(coalesce(location_source, '')) <= 2000);

-- A LinkedIn URL means the company has LinkedIn.
CREATE OR REPLACE FUNCTION public.crm_company_linkedin() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.linkedin_url IS NOT NULL AND btrim(NEW.linkedin_url) <> '' THEN NEW.has_linkedin := true; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crm_company_linkedin ON crm_companies;
CREATE TRIGGER trg_crm_company_linkedin BEFORE INSERT OR UPDATE OF linkedin_url, has_linkedin ON crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.crm_company_linkedin();
REVOKE ALL ON FUNCTION public.crm_company_linkedin() FROM PUBLIC, anon, authenticated;

-- Imports fill the same columns.
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
        INSERT INTO crm_companies (workspace_id, client_id, name, domain, industry, phone, email, notes, custom,
                                   has_linkedin, linkedin_url, listed_location, prospect_type, contact_status, contact_sources, location_source,
                                   owner_id, created_by)
        VALUES (p_workspace_id, p_client_id, v_name, nullif(left(btrim(r ->> 'domain'), 200), ''), nullif(left(btrim(r ->> 'industry'), 100), ''),
                nullif(left(btrim(r ->> 'phone'), 50), ''), nullif(left(btrim(r ->> 'email'), 320), ''), left(coalesce(r ->> 'notes', ''), 20000),
                v_custom,
                lower(coalesce(r ->> 'has_linkedin', '')) IN ('yes', 'true', 'y', 'da', '1'),
                nullif(left(btrim(r ->> 'linkedin_url'), 500), ''), nullif(left(btrim(r ->> 'listed_location'), 200), ''),
                nullif(left(btrim(r ->> 'prospect_type'), 100), ''), nullif(left(btrim(r ->> 'contact_status'), 100), ''),
                nullif(left(btrim(r ->> 'contact_sources'), 2000), ''), nullif(left(btrim(r ->> 'location_source'), 2000), ''),
                v_uid, v_uid);
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
