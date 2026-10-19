-- Supporting CRM: shared within a workspace; creators, owners and admins may edit.
-- Associations never confer permission on a file, task or channel.
CREATE TABLE IF NOT EXISTS crm_pipelines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),created_by uuid NOT NULL REFERENCES auth.users(id),UNIQUE(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS crm_stages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,pipeline_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),position integer NOT NULL DEFAULT 0,
 probability integer NOT NULL DEFAULT 0 CHECK(probability BETWEEN 0 AND 100),
 FOREIGN KEY(pipeline_id,workspace_id) REFERENCES crm_pipelines(id,workspace_id) ON DELETE CASCADE,UNIQUE(id,workspace_id),UNIQUE(id,pipeline_id,workspace_id)
);
CREATE TABLE IF NOT EXISTS crm_companies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),domain text,owner_id uuid NOT NULL REFERENCES auth.users(id),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=20000),created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS crm_contacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),email text,phone text,company_id uuid,
 owner_id uuid NOT NULL REFERENCES auth.users(id),lifecycle_stage text NOT NULL DEFAULT 'lead',tags text[] NOT NULL DEFAULT '{}',
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=20000),created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,workspace_id),
 FOREIGN KEY(company_id,workspace_id) REFERENCES crm_companies(id,workspace_id),
 CHECK(email IS NULL OR email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$')
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_email ON crm_contacts(workspace_id,lower(email)) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS crm_deals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),company_id uuid,contact_id uuid,pipeline_id uuid NOT NULL,stage_id uuid NOT NULL,
 value numeric(16,2) NOT NULL DEFAULT 0 CHECK(value>=0),currency text NOT NULL DEFAULT 'EUR' CHECK(currency ~ '^[A-Z]{3}$'),
 owner_id uuid NOT NULL REFERENCES auth.users(id),expected_close date,
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=20000),created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,workspace_id),
 FOREIGN KEY(company_id,workspace_id) REFERENCES crm_companies(id,workspace_id),
 FOREIGN KEY(contact_id,workspace_id) REFERENCES crm_contacts(id,workspace_id),
 FOREIGN KEY(stage_id,pipeline_id,workspace_id) REFERENCES crm_stages(id,pipeline_id,workspace_id)
);
CREATE TABLE IF NOT EXISTS crm_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 company_id uuid,contact_id uuid,deal_id uuid,item_id uuid,task_id uuid,channel_id uuid,
 created_by uuid NOT NULL REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(company_id,contact_id,deal_id)=1),CHECK(num_nonnulls(item_id,task_id,channel_id)=1),
 FOREIGN KEY(company_id,workspace_id) REFERENCES crm_companies(id,workspace_id),
 FOREIGN KEY(contact_id,workspace_id) REFERENCES crm_contacts(id,workspace_id),
 FOREIGN KEY(deal_id,workspace_id) REFERENCES crm_deals(id,workspace_id),
 FOREIGN KEY(item_id,workspace_id) REFERENCES drive_items(id,workspace_id),
 FOREIGN KEY(task_id,workspace_id) REFERENCES tasks(id,workspace_id),
 FOREIGN KEY(channel_id,workspace_id) REFERENCES channels(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS crm_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 record_type text NOT NULL,record_id uuid NOT NULL,actor_id uuid REFERENCES auth.users(id),action text NOT NULL,
 changes jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_activity_record ON crm_activity(workspace_id,record_id,created_at DESC);
CREATE INDEX IF NOT EXISTS crm_deals_pipeline ON crm_deals(workspace_id,pipeline_id,stage_id);

CREATE OR REPLACE FUNCTION crm_validate_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT user_is_workspace_member(NEW.workspace_id,NEW.owner_id) THEN RAISE EXCEPTION 'Owner must be a workspace member' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN NEW.created_by:=auth.uid();
 ELSE
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'Immutable tenant and author' USING ERRCODE='42501'; END IF;
  NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION crm_log_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO crm_activity(workspace_id,record_type,record_id,actor_id,action,changes)
 VALUES(NEW.workspace_id,TG_TABLE_NAME,NEW.id,auth.uid(),lower(TG_OP),
 CASE WHEN TG_OP='INSERT' THEN jsonb_build_object('created',true)
 ELSE (SELECT coalesce(jsonb_object_agg(n.key,n.value),'{}') FROM jsonb_each(to_jsonb(NEW)) n WHERE n.key NOT IN ('notes','updated_at') AND n.value IS DISTINCT FROM to_jsonb(OLD)->n.key) END);
 INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,metadata)
 VALUES(NEW.workspace_id,auth.uid(),'crm_'||lower(TG_OP),TG_TABLE_NAME,NEW.id,'{}');
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['crm_companies','crm_contacts','crm_deals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(workspace_id,updated_at DESC)',t||'_workspace',t);
  EXECUTE format('CREATE POLICY member_read ON %I FOR SELECT TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()))',t);
  EXECUTE format('CREATE POLICY member_create ON %I FOR INSERT TO authenticated WITH CHECK(user_is_workspace_member(workspace_id,auth.uid()) AND created_by=auth.uid())',t);
  EXECUTE format('CREATE POLICY owner_edit ON %I FOR UPDATE TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()) AND (owner_id=auth.uid() OR created_by=auth.uid() OR user_is_workspace_admin(workspace_id,auth.uid()))) WITH CHECK(user_is_workspace_member(workspace_id,auth.uid()))',t);
  EXECUTE format('CREATE TRIGGER validate_change BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION crm_validate_change()',t);
  EXECUTE format('CREATE TRIGGER log_change AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION crm_log_change()',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO authenticated',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['crm_pipelines','crm_stages','crm_activity','crm_links'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
CREATE POLICY pipeline_read ON crm_pipelines FOR SELECT TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()));
CREATE POLICY stage_read ON crm_stages FOR SELECT TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()));
CREATE POLICY activity_read ON crm_activity FOR SELECT TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()));
CREATE POLICY links_read ON crm_links FOR SELECT TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()) AND
 (item_id IS NULL OR drive_can_view(item_id,auth.uid())) AND (task_id IS NULL OR task_visible_to(task_id,auth.uid())) AND (channel_id IS NULL OR user_is_channel_member(channel_id,auth.uid())));
CREATE POLICY links_create ON crm_links FOR INSERT TO authenticated WITH CHECK(created_by=auth.uid() AND user_is_workspace_member(workspace_id,auth.uid()) AND
 (item_id IS NULL OR drive_can_view(item_id,auth.uid())) AND (task_id IS NULL OR task_visible_to(task_id,auth.uid())) AND (channel_id IS NULL OR user_is_channel_member(channel_id,auth.uid())));
CREATE POLICY links_delete ON crm_links FOR DELETE TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()) AND (created_by=auth.uid() OR user_is_workspace_admin(workspace_id,auth.uid())));
GRANT SELECT ON crm_pipelines,crm_stages,crm_activity TO authenticated;
GRANT SELECT,INSERT,DELETE ON crm_links TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON crm_activity,crm_pipelines,crm_stages FROM anon,authenticated;

CREATE OR REPLACE FUNCTION crm_create_pipeline(p_workspace_id uuid,p_name text,p_stages text[] DEFAULT ARRAY['New','Qualified','Proposal','Negotiation','Won','Lost'])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; stage text; n integer:=0;
BEGIN
 IF NOT user_is_workspace_admin(p_workspace_id,auth.uid()) THEN RAISE EXCEPTION 'Only workspace admins can configure pipelines' USING ERRCODE='42501'; END IF;
 IF cardinality(p_stages) NOT BETWEEN 2 AND 20 THEN RAISE EXCEPTION 'Choose 2 to 20 stages' USING ERRCODE='22023'; END IF;
 INSERT INTO crm_pipelines(workspace_id,name,created_by) VALUES(p_workspace_id,p_name,auth.uid()) RETURNING id INTO v_id;
 FOREACH stage IN ARRAY p_stages LOOP INSERT INTO crm_stages(workspace_id,pipeline_id,name,position) VALUES(p_workspace_id,v_id,stage,n);n:=n+1;END LOOP;
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION crm_create_pipeline(uuid,text,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION crm_create_pipeline(uuid,text,text[]) TO authenticated;
REVOKE ALL ON FUNCTION crm_validate_change(),crm_log_change() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
