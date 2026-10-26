-- ============================================================================
-- 20261026000700_social.sql
-- ----------------------------------------------------------------------------
-- Social posting for our brand and the companies we manage (CRM companies in
-- our own CRM). Each company has its social accounts; a post goes to several
-- accounts at once, now or at a scheduled time. The worker publishes each
-- target with profullstack/social-poster (browser automation) using the
-- account's saved login session.
--
-- Sessions are browser cookies — as good as a password — so they live in
-- social_account_sessions, encrypted by the server and never granted to
-- clients. Admins connect and remove accounts; members compose and schedule.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id uuid REFERENCES crm_companies(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('x', 'linkedin', 'facebook', 'pinterest', 'tiktok')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'needs_login' CHECK (status IN ('needs_login', 'connected', 'error')),
  last_error text,
  connected_at timestamptz,
  last_used_at timestamptz,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_accounts_company ON social_accounts (workspace_id, company_id);
CREATE INDEX IF NOT EXISTS social_accounts_created_by ON social_accounts (created_by);

CREATE TABLE IF NOT EXISTS public.social_account_sessions (
  account_id uuid PRIMARY KEY REFERENCES social_accounts(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE social_account_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON social_account_sessions FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id uuid REFERENCES crm_companies(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  link text CHECK (link IS NULL OR (link ~* '^https?://' AND length(link) <= 2000)),
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled')),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_posts_company ON social_posts (workspace_id, company_id, coalesce(scheduled_at, created_at) DESC);
CREATE INDEX IF NOT EXISTS social_posts_created_by ON social_posts (created_by);

CREATE TABLE IF NOT EXISTS public.social_post_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'cancelled')),
  error text,
  published_at timestamptz,
  UNIQUE (post_id, account_id)
);
CREATE INDEX IF NOT EXISTS social_post_targets_workspace ON social_post_targets (workspace_id);
CREATE INDEX IF NOT EXISTS social_post_targets_account ON social_post_targets (account_id);

ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_post_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON social_accounts, social_posts, social_post_targets FROM anon, authenticated;
DROP POLICY IF EXISTS social_accounts_read ON social_accounts;
CREATE POLICY social_accounts_read ON social_accounts FOR SELECT TO authenticated
  USING (user_is_workspace_member(workspace_id, auth.uid()) AND feature_visible_to(workspace_id, auth.uid(), 'social'));
DROP POLICY IF EXISTS social_accounts_admin ON social_accounts;
CREATE POLICY social_accounts_admin ON social_accounts FOR ALL TO authenticated
  USING (user_is_workspace_admin(workspace_id, auth.uid()))
  WITH CHECK (user_is_workspace_admin(workspace_id, auth.uid()) AND created_by = auth.uid());
DROP POLICY IF EXISTS social_posts_read ON social_posts;
CREATE POLICY social_posts_read ON social_posts FOR SELECT TO authenticated
  USING (user_is_workspace_member(workspace_id, auth.uid()) AND feature_visible_to(workspace_id, auth.uid(), 'social'));
DROP POLICY IF EXISTS social_targets_read ON social_post_targets;
CREATE POLICY social_targets_read ON social_post_targets FOR SELECT TO authenticated
  USING (user_is_workspace_member(workspace_id, auth.uid()) AND feature_visible_to(workspace_id, auth.uid(), 'social'));
GRANT SELECT ON social_posts, social_post_targets TO authenticated;
GRANT SELECT, INSERT, DELETE ON social_accounts TO authenticated;
GRANT UPDATE (label) ON social_accounts TO authenticated;

-- An account belongs to our brand (no company) or a company in our own CRM.
CREATE OR REPLACE FUNCTION public.social_account_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_companies WHERE id = NEW.company_id AND workspace_id = NEW.workspace_id AND client_id IS NULL) THEN
    RAISE EXCEPTION 'Choose a company from our CRM' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'needs_login'; NEW.connected_at := NULL; NEW.last_error := NULL;
  ELSIF NEW.workspace_id <> OLD.workspace_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.platform <> OLD.platform THEN
    RAISE EXCEPTION 'Create a new account instead' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_social_account_check ON social_accounts;
CREATE TRIGGER trg_social_account_check BEFORE INSERT OR UPDATE ON social_accounts FOR EACH ROW EXECUTE FUNCTION public.social_account_check();

-- A post's status follows its targets.
CREATE OR REPLACE FUNCTION public.social_post_rollup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_post uuid := coalesce(NEW.post_id, OLD.post_id); v_total int; v_done int; v_failed int; v_busy int; v_cancelled int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'published'), count(*) FILTER (WHERE status = 'failed'),
         count(*) FILTER (WHERE status = 'publishing'), count(*) FILTER (WHERE status = 'cancelled')
    INTO v_total, v_done, v_failed, v_busy, v_cancelled
    FROM social_post_targets WHERE post_id = v_post;
  UPDATE social_posts SET updated_at = now(), status = CASE
      WHEN v_total = 0 OR v_cancelled = v_total THEN 'cancelled'
      WHEN v_busy > 0 THEN 'publishing'
      WHEN v_done + v_failed + v_cancelled < v_total THEN CASE WHEN v_done + v_failed > 0 THEN 'publishing' ELSE 'scheduled' END
      WHEN v_failed = 0 THEN 'published'
      WHEN v_done = 0 THEN 'failed'
      ELSE 'partial' END
   WHERE id = v_post;
  PERFORM pg_notify('app_changes', json_build_object('table', 'social_posts', 'event', 'UPDATE', 'id', v_post)::text);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_social_post_rollup ON social_post_targets;
CREATE TRIGGER trg_social_post_rollup AFTER INSERT OR UPDATE OF status OR DELETE ON social_post_targets
  FOR EACH ROW EXECUTE FUNCTION public.social_post_rollup();

-- Create or reschedule a post for the chosen accounts; NULL p_scheduled_at posts now.
CREATE OR REPLACE FUNCTION public.social_schedule_post(
  p_workspace_id uuid, p_company_id uuid, p_body text, p_link text, p_account_ids uuid[],
  p_scheduled_at timestamptz DEFAULT NULL, p_post_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_post uuid := p_post_id; v_target record; v_run timestamptz := greatest(coalesce(p_scheduled_at, now()), now());
BEGIN
  IF v_uid IS NULL OR NOT user_is_workspace_member(p_workspace_id, v_uid) OR NOT feature_visible_to(p_workspace_id, v_uid, 'social') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF cardinality(coalesce(p_account_ids, '{}')) = 0 THEN RAISE EXCEPTION 'Choose at least one account' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_account_ids) a(id) LEFT JOIN social_accounts s ON s.id = a.id
              WHERE s.id IS NULL OR s.workspace_id <> p_workspace_id OR s.company_id IS DISTINCT FROM p_company_id) THEN
    RAISE EXCEPTION 'Choose accounts of this company' USING ERRCODE = '22023';
  END IF;
  IF v_post IS NULL THEN
    INSERT INTO social_posts (workspace_id, company_id, body, link, scheduled_at, created_by)
    VALUES (p_workspace_id, p_company_id, btrim(p_body), nullif(btrim(coalesce(p_link, '')), ''), p_scheduled_at, v_uid)
    RETURNING id INTO v_post;
  ELSE
    UPDATE social_posts SET body = btrim(p_body), link = nullif(btrim(coalesce(p_link, '')), ''), scheduled_at = p_scheduled_at, updated_at = now()
     WHERE id = v_post AND workspace_id = p_workspace_id AND company_id IS NOT DISTINCT FROM p_company_id
       AND status IN ('scheduled', 'failed', 'partial', 'cancelled')
       AND (created_by = v_uid OR user_is_workspace_admin(p_workspace_id, v_uid));
    IF NOT FOUND THEN RAISE EXCEPTION 'This post can no longer be changed' USING ERRCODE = '42501'; END IF;
    DELETE FROM social_post_targets WHERE post_id = v_post AND status <> 'published' AND NOT (account_id = ANY(p_account_ids));
  END IF;
  INSERT INTO social_post_targets (workspace_id, post_id, account_id)
  SELECT p_workspace_id, v_post, a FROM unnest(p_account_ids) a
  ON CONFLICT (post_id, account_id) DO UPDATE SET status = CASE WHEN social_post_targets.status = 'published' THEN 'published' ELSE 'pending' END, error = NULL;
  FOR v_target IN SELECT id FROM social_post_targets WHERE post_id = v_post AND status = 'pending' LOOP
    PERFORM enqueue_job('social.publish', p_workspace_id, v_uid,
      jsonb_build_object('target_id', v_target.id, 'run_at', v_run),
      'social:' || v_target.id || ':' || extract(epoch FROM v_run)::bigint || ':' || extract(epoch FROM clock_timestamp())::bigint,
      v_run, 2);
  END LOOP;
  RETURN v_post;
END $$;

CREATE OR REPLACE FUNCTION public.social_cancel_post(p_post_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_post social_posts%ROWTYPE;
BEGIN
  SELECT * INTO v_post FROM social_posts WHERE id = p_post_id;
  IF v_post.id IS NULL OR NOT (v_post.created_by = auth.uid() OR user_is_workspace_admin(v_post.workspace_id, auth.uid())) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE social_post_targets SET status = 'cancelled' WHERE post_id = p_post_id AND status = 'pending';
END $$;

CREATE OR REPLACE FUNCTION public.social_delete_post(p_post_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_post social_posts%ROWTYPE;
BEGIN
  SELECT * INTO v_post FROM social_posts WHERE id = p_post_id;
  IF v_post.id IS NULL OR NOT (v_post.created_by = auth.uid() OR user_is_workspace_admin(v_post.workspace_id, auth.uid())) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM social_post_targets WHERE post_id = p_post_id AND status = 'publishing') THEN
    RAISE EXCEPTION 'This post is being published right now' USING ERRCODE = '55006';
  END IF;
  DELETE FROM social_posts WHERE id = p_post_id;
END $$;

-- Social can be hidden from the team like the other features.
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'workspace_member_features'::regclass AND contype = 'c' LIMIT 1;
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE workspace_member_features DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE workspace_member_features ADD CONSTRAINT workspace_member_features_hidden_known
  CHECK (hidden <@ ARRAY['ai', 'crm', 'drive', 'calendar', 'projects', 'automation', 'social']::text[]);

REVOKE ALL ON FUNCTION public.social_account_check(), public.social_post_rollup() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.social_schedule_post(uuid, uuid, text, text, uuid[], timestamptz, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.social_cancel_post(uuid), public.social_delete_post(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.social_schedule_post(uuid, uuid, text, text, uuid[], timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.social_cancel_post(uuid), public.social_delete_post(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
