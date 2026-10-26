-- ============================================================================
-- 20261026000400_crm_workspace.sql
-- ----------------------------------------------------------------------------
-- The CRM workspace, after OpenCRM (MIT, clawnify/OpenCRM): richer records,
-- pipeline stages with colours and won/lost meaning, a notes timeline, shared
-- saved views (filters, sort, columns) and custom properties.
--
-- Custom property values live in each record's `custom` jsonb, keyed by the
-- property's key; crm_custom_fields is only the registry. Customers are
-- companies with customer_since set: by hand, or the day their first deal is
-- won. Contact emails are unique within one CRM (ours or a client's).
-- ============================================================================

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS customer_since date,
  ADD COLUMN IF NOT EXISTS renewal_date date,
  ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE crm_deals
  ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm_companies', 'crm_contacts', 'crm_deals'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_custom_object');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (jsonb_typeof(custom) = ''object'' AND pg_column_size(custom) <= 32768)', t, t || '_custom_object');
  END LOOP;
END $$;
ALTER TABLE crm_companies DROP CONSTRAINT IF EXISTS crm_companies_lengths;
ALTER TABLE crm_companies ADD CONSTRAINT crm_companies_lengths
  CHECK (length(coalesce(industry, '')) <= 100 AND length(coalesce(phone, '')) <= 50 AND length(coalesce(email, '')) <= 320);
ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_title_length;
ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_title_length CHECK (length(coalesce(title, '')) <= 200);

DROP INDEX IF EXISTS crm_contacts_email;
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_email_per_crm
  ON crm_contacts (workspace_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email)) WHERE email IS NOT NULL;

-- ── Stages ──────────────────────────────────────────────────────────────────
ALTER TABLE crm_stages
  ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'slate',
  ADD COLUMN IF NOT EXISTS is_won boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_lost boolean NOT NULL DEFAULT false;
ALTER TABLE crm_stages DROP CONSTRAINT IF EXISTS crm_stages_color;
ALTER TABLE crm_stages ADD CONSTRAINT crm_stages_color
  CHECK (color IN ('slate', 'sky', 'teal', 'emerald', 'amber', 'orange', 'rose', 'fuchsia', 'violet'));
ALTER TABLE crm_stages DROP CONSTRAINT IF EXISTS crm_stages_won_or_lost;
ALTER TABLE crm_stages ADD CONSTRAINT crm_stages_won_or_lost CHECK (NOT (is_won AND is_lost));

UPDATE crm_stages SET is_won = true, color = 'emerald' WHERE lower(name) IN ('won', 'closed won') AND NOT is_won AND NOT is_lost;
UPDATE crm_stages SET is_lost = true, color = 'rose' WHERE lower(name) IN ('lost', 'closed lost') AND NOT is_won AND NOT is_lost;
UPDATE crm_stages SET color = (ARRAY['sky', 'violet', 'amber', 'orange', 'teal', 'fuchsia'])[1 + position % 6]
 WHERE color = 'slate' AND NOT is_won AND NOT is_lost;

-- New pipelines recognise their won and lost stages by name, and get colours.
CREATE OR REPLACE FUNCTION crm_create_pipeline(p_workspace_id uuid, p_name text, p_stages text[] DEFAULT ARRAY['New','Qualified','Proposal','Negotiation','Won','Lost'])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; stage text; n integer := 0; v_won boolean; v_lost boolean;
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN RAISE EXCEPTION 'Only workspace admins can configure pipelines' USING ERRCODE = '42501'; END IF;
  IF cardinality(p_stages) NOT BETWEEN 2 AND 20 THEN RAISE EXCEPTION 'Choose 2 to 20 stages' USING ERRCODE = '22023'; END IF;
  INSERT INTO crm_pipelines (workspace_id, name, created_by) VALUES (p_workspace_id, p_name, auth.uid()) RETURNING id INTO v_id;
  FOREACH stage IN ARRAY p_stages LOOP
    v_won := lower(btrim(stage)) IN ('won', 'closed won');
    v_lost := lower(btrim(stage)) IN ('lost', 'closed lost');
    INSERT INTO crm_stages (workspace_id, pipeline_id, name, position, is_won, is_lost, color)
    VALUES (p_workspace_id, v_id, btrim(stage), n, v_won, v_lost,
            CASE WHEN v_won THEN 'emerald' WHEN v_lost THEN 'rose' ELSE (ARRAY['sky', 'violet', 'amber', 'orange', 'teal', 'fuchsia'])[1 + n % 6] END);
    n := n + 1;
  END LOOP;
  RETURN v_id;
END $$;

-- Deleting a contact or deal must not read company-only fields.
CREATE OR REPLACE FUNCTION public.crm_before_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'crm_companies' THEN
    IF (to_jsonb(OLD) ->> 'is_client')::boolean AND (
       EXISTS (SELECT 1 FROM crm_companies WHERE client_id = OLD.id) OR EXISTS (SELECT 1 FROM crm_contacts WHERE client_id = OLD.id)
       OR EXISTS (SELECT 1 FROM crm_deals WHERE client_id = OLD.id)) THEN
      RAISE EXCEPTION '% still has records in its own CRM. Delete those first.', OLD.name USING ERRCODE = '23503';
    END IF;
  END IF;
  INSERT INTO crm_activity (workspace_id, record_type, record_id, actor_id, action, changes)
  VALUES (OLD.workspace_id, TG_TABLE_NAME, OLD.id, auth.uid(), 'delete', jsonb_build_object('name', OLD.name));
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (OLD.workspace_id, auth.uid(), 'crm_delete', TG_TABLE_NAME, OLD.id, jsonb_build_object('name', OLD.name));
  RETURN OLD;
END $$;

-- Admins add, edit, reorder and remove stages. A removed stage's deals move
-- to p_move_to (another stage of the same pipeline).
CREATE OR REPLACE FUNCTION public.crm_save_stage(
  p_workspace_id uuid, p_pipeline_id uuid, p_stage_id uuid, p_name text, p_color text,
  p_is_won boolean DEFAULT false, p_is_lost boolean DEFAULT false, p_position integer DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN RAISE EXCEPTION 'Only workspace admins can configure pipelines' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM crm_pipelines WHERE id = p_pipeline_id AND workspace_id = p_workspace_id) THEN RAISE EXCEPTION 'Pipeline not found' USING ERRCODE = '22023'; END IF;
  IF p_stage_id IS NULL THEN
    INSERT INTO crm_stages (workspace_id, pipeline_id, name, color, is_won, is_lost, position)
    VALUES (p_workspace_id, p_pipeline_id, btrim(p_name), p_color, p_is_won, p_is_lost,
            coalesce(p_position, (SELECT coalesce(max(position) + 1, 0) FROM crm_stages WHERE pipeline_id = p_pipeline_id)))
    RETURNING id INTO v_id;
  ELSE
    UPDATE crm_stages SET name = btrim(p_name), color = p_color, is_won = p_is_won, is_lost = p_is_lost, position = coalesce(p_position, position)
     WHERE id = p_stage_id AND pipeline_id = p_pipeline_id AND workspace_id = p_workspace_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Stage not found' USING ERRCODE = '22023'; END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.crm_reorder_stages(p_workspace_id uuid, p_pipeline_id uuid, p_stage_ids uuid[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN RAISE EXCEPTION 'Only workspace admins can configure pipelines' USING ERRCODE = '42501'; END IF;
  UPDATE crm_stages s SET position = o.n - 1
    FROM unnest(p_stage_ids) WITH ORDINALITY AS o(id, n)
   WHERE s.id = o.id AND s.pipeline_id = p_pipeline_id AND s.workspace_id = p_workspace_id;
END $$;

CREATE OR REPLACE FUNCTION public.crm_delete_stage(p_workspace_id uuid, p_stage_id uuid, p_move_to uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_pipeline uuid;
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN RAISE EXCEPTION 'Only workspace admins can configure pipelines' USING ERRCODE = '42501'; END IF;
  SELECT pipeline_id INTO v_pipeline FROM crm_stages WHERE id = p_stage_id AND workspace_id = p_workspace_id;
  IF v_pipeline IS NULL THEN RAISE EXCEPTION 'Stage not found' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) FROM crm_stages WHERE pipeline_id = v_pipeline) <= 2 THEN RAISE EXCEPTION 'A pipeline needs at least two stages' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM crm_deals WHERE stage_id = p_stage_id) THEN
    IF p_move_to IS NULL OR p_move_to = p_stage_id OR NOT EXISTS (SELECT 1 FROM crm_stages WHERE id = p_move_to AND pipeline_id = v_pipeline) THEN
      RAISE EXCEPTION 'Choose another stage of this pipeline for its deals' USING ERRCODE = '22023';
    END IF;
    UPDATE crm_deals SET stage_id = p_move_to WHERE stage_id = p_stage_id;
  END IF;
  DELETE FROM crm_stages WHERE id = p_stage_id;
END $$;

-- A company becomes a customer the day its first deal is won.
CREATE OR REPLACE FUNCTION public.crm_deal_won() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.company_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id)
     AND EXISTS (SELECT 1 FROM crm_stages WHERE id = NEW.stage_id AND is_won) THEN
    BEGIN
      UPDATE crm_companies SET customer_since = current_date WHERE id = NEW.company_id AND customer_since IS NULL;
    EXCEPTION WHEN others THEN NULL; -- e.g. its owner left the workspace; set it by hand
    END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crm_deal_won ON crm_deals;
CREATE TRIGGER trg_crm_deal_won AFTER INSERT OR UPDATE OF stage_id ON crm_deals FOR EACH ROW EXECUTE FUNCTION public.crm_deal_won();

-- ── Notes timeline ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN ('crm_companies', 'crm_contacts', 'crm_deals')),
  record_id uuid NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  author_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_notes_record ON crm_notes (workspace_id, record_id, created_at DESC);
ALTER TABLE crm_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notes_read ON crm_notes;
CREATE POLICY notes_read ON crm_notes FOR SELECT TO authenticated USING (user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS notes_create ON crm_notes;
CREATE POLICY notes_create ON crm_notes FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid() AND user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS notes_edit ON crm_notes;
CREATE POLICY notes_edit ON crm_notes FOR UPDATE TO authenticated USING (author_id = auth.uid()) WITH CHECK (author_id = auth.uid());
DROP POLICY IF EXISTS notes_delete ON crm_notes;
CREATE POLICY notes_delete ON crm_notes FOR DELETE TO authenticated
  USING (author_id = auth.uid() OR user_is_workspace_admin(workspace_id, auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_notes TO authenticated;

CREATE OR REPLACE FUNCTION public.crm_note_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ws uuid;
BEGIN
  EXECUTE format('SELECT workspace_id FROM %I WHERE id = $1', NEW.record_type) INTO v_ws USING NEW.record_id;
  IF v_ws IS DISTINCT FROM NEW.workspace_id THEN RAISE EXCEPTION 'Record not found' USING ERRCODE = '22023'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.record_id <> OLD.record_id OR NEW.record_type <> OLD.record_type OR NEW.workspace_id <> OLD.workspace_id THEN
      RAISE EXCEPTION 'A note stays on its record' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crm_note_check ON crm_notes;
CREATE TRIGGER trg_crm_note_check BEFORE INSERT OR UPDATE ON crm_notes FOR EACH ROW EXECUTE FUNCTION public.crm_note_check();

-- Notes go with their record.
CREATE OR REPLACE FUNCTION public.crm_delete_notes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM crm_notes WHERE record_id = OLD.id AND record_type = TG_TABLE_NAME;
  RETURN OLD;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm_companies', 'crm_contacts', 'crm_deals'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS delete_notes ON %I', t);
    EXECUTE format('CREATE TRIGGER delete_notes AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.crm_delete_notes()', t);
  END LOOP;
END $$;

-- ── Saved views ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('contacts', 'companies', 'deals')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  filters jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(filters) = 'array' AND pg_column_size(filters) <= 16384),
  sort text CHECK (sort ~ '^[a-z][a-z0-9_.]{0,60}$'),
  sort_desc boolean NOT NULL DEFAULT false,
  columns jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(columns) = 'object' AND pg_column_size(columns) <= 16384),
  position double precision NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_views_entity ON crm_views (workspace_id, entity, position);
ALTER TABLE crm_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS views_read ON crm_views;
CREATE POLICY views_read ON crm_views FOR SELECT TO authenticated USING (user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS views_create ON crm_views;
CREATE POLICY views_create ON crm_views FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid() AND user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS views_edit ON crm_views;
CREATE POLICY views_edit ON crm_views FOR UPDATE TO authenticated
  USING (user_is_workspace_member(workspace_id, auth.uid())) WITH CHECK (user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS views_delete ON crm_views;
CREATE POLICY views_delete ON crm_views FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR user_is_workspace_admin(workspace_id, auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_views TO authenticated;

CREATE OR REPLACE FUNCTION public.crm_view_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.created_by <> OLD.created_by OR NEW.entity <> OLD.entity THEN
    RAISE EXCEPTION 'Immutable view owner' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crm_view_touch ON crm_views;
CREATE TRIGGER trg_crm_view_touch BEFORE UPDATE ON crm_views FOR EACH ROW EXECUTE FUNCTION public.crm_view_touch();

-- ── Custom properties ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_custom_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('contacts', 'companies', 'deals')),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  field_type text NOT NULL CHECK (field_type IN ('text', 'long_text', 'number', 'checkbox', 'date', 'select', 'url', 'email', 'phone', 'tags')),
  options jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(options) = 'object' AND pg_column_size(options) <= 8192),
  position double precision NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity, key)
);
ALTER TABLE crm_custom_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fields_read ON crm_custom_fields;
CREATE POLICY fields_read ON crm_custom_fields FOR SELECT TO authenticated USING (user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS fields_manage ON crm_custom_fields;
CREATE POLICY fields_manage ON crm_custom_fields FOR ALL TO authenticated
  USING (user_is_workspace_admin(workspace_id, auth.uid()))
  WITH CHECK (user_is_workspace_admin(workspace_id, auth.uid()) AND created_by = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_custom_fields TO authenticated;

REVOKE ALL ON FUNCTION public.crm_save_stage(uuid, uuid, uuid, text, text, boolean, boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_reorder_stages(uuid, uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_delete_stage(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_save_stage(uuid, uuid, uuid, text, text, boolean, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_reorder_stages(uuid, uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_delete_stage(uuid, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.crm_deal_won(), public.crm_note_check(), public.crm_delete_notes(), public.crm_view_touch() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
