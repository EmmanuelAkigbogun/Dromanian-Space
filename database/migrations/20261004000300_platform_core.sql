-- ============================================================================
-- 20261004000300_platform_core.sql
-- ----------------------------------------------------------------------------
-- Shared foundations for Drive, Agents, CRM and the new shell:
--   1. (id, workspace_id) keys so new tables can use composite foreign keys
--      that make cross-tenant references impossible.
--   2. Durable job queue (leases, attempts, backoff, dead letters, idempotency).
--   3. Per-user, per-workspace preferences (navigation, pinned agents, composer).
--   4. Personal sidebar categories (navigation only; never permissions).
--   5. Channel notification preferences (mute / level) on channel_members.
--   6. Thread follows for the Threads view.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Composite keys on tenant parents.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_id_workspace_key') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_id_workspace_key UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_id_workspace_key') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_id_workspace_key UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_id_workspace_key') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_id_workspace_key UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_id_workspace_key') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_id_workspace_key UNIQUE (id, workspace_id);
  END IF;
END $$;

-- Every message row must carry its workspace (046 backfilled it; enforce now).
UPDATE messages m SET workspace_id = c.workspace_id FROM channels c
WHERE m.channel_id = c.id AND m.workspace_id IS DISTINCT FROM c.workspace_id;
ALTER TABLE messages ALTER COLUMN workspace_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Job queue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{2,63}$'),
  -- Execution identity: the user whose current access the job runs under.
  -- NULL only for system maintenance jobs.
  principal_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 16384),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  idempotency_key text,
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idempotency ON jobs (kind, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs (run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_leases ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs (workspace_id, created_at DESC);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
-- Members may read jobs they are the principal of (progress/failure display).
DROP POLICY IF EXISTS "jobs_select_own" ON jobs;
CREATE POLICY "jobs_select_own" ON jobs FOR SELECT TO authenticated
  USING (principal_id = auth.uid() AND public.user_is_workspace_member(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON jobs FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.job_attempts (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  worker text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'retry', 'failed', 'dead', 'lease_expired', 'cancelled')),
  error text
);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts (job_id, attempt);
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON job_attempts FROM anon, authenticated;

-- Enqueue (server/definer use). Idempotent per (kind, idempotency_key).
CREATE OR REPLACE FUNCTION public.enqueue_job(
  p_kind text, p_workspace_id uuid, p_principal_id uuid, p_payload jsonb,
  p_idempotency_key text DEFAULT NULL, p_run_after timestamptz DEFAULT now(), p_max_attempts integer DEFAULT 5
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_id FROM jobs WHERE kind = p_kind AND idempotency_key = p_idempotency_key;
    IF v_id IS NOT NULL THEN
      -- Re-arm a finished job only if explicitly requested by a new key; an
      -- existing queued/running job is reused (no duplicate work).
      RETURN v_id;
    END IF;
  END IF;
  INSERT INTO jobs (kind, workspace_id, principal_id, payload, idempotency_key, run_after, max_attempts)
  VALUES (p_kind, p_workspace_id, p_principal_id, coalesce(p_payload, '{}'::jsonb), p_idempotency_key, p_run_after, p_max_attempts)
  ON CONFLICT (kind, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Claim up to p_limit jobs atomically. Expired leases are reclaimed; a job
-- that exhausted its attempts while leased becomes dead.
CREATE OR REPLACE FUNCTION public.claim_jobs(
  p_worker text, p_kinds text[] DEFAULT NULL, p_limit integer DEFAULT 5, p_lease_seconds integer DEFAULT 120
) RETURNS SETOF jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  -- Leases that expired mid-run count as a failed attempt.
  WITH expired AS (
    UPDATE jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
      lease_owner = NULL, lease_expires_at = NULL,
      last_error = coalesce(last_error, 'Worker lease expired before completion'),
      run_after = now(), updated_at = now(),
      finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
    WHERE status = 'running' AND lease_expires_at < now()
    RETURNING id, attempts
  )
  UPDATE job_attempts a SET outcome = 'lease_expired', finished_at = now()
  FROM expired e WHERE a.job_id = e.id AND a.attempt = e.attempts AND a.outcome IS NULL;

  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM jobs j
    WHERE j.status = 'queued' AND j.run_after <= now()
      AND (p_kinds IS NULL OR j.kind = ANY(p_kinds))
    ORDER BY j.run_after, j.created_at
    LIMIT greatest(1, least(p_limit, 50))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE jobs j SET status = 'running', attempts = j.attempts + 1, lease_owner = p_worker,
      lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 900))),
      started_at = coalesce(j.started_at, now()), updated_at = now()
    FROM picked WHERE j.id = picked.id
    RETURNING j.*
  ), logged AS (
    INSERT INTO job_attempts (job_id, attempt, worker) SELECT id, attempts, p_worker FROM claimed
  )
  SELECT * FROM claimed;
END $$;

CREATE OR REPLACE FUNCTION public.heartbeat_job(p_job_id uuid, p_worker text, p_lease_seconds integer DEFAULT 120)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH u AS (
    UPDATE jobs SET lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 900))), updated_at = now()
    WHERE id = p_job_id AND lease_owner = p_worker AND status = 'running' RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM u);
$$;

-- Output must be stored durably by the caller before completing.
CREATE OR REPLACE FUNCTION public.complete_job(p_job_id uuid, p_worker text, p_result jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_attempt integer;
BEGIN
  UPDATE jobs SET status = 'succeeded', result = p_result, lease_owner = NULL, lease_expires_at = NULL,
    finished_at = now(), updated_at = now(), last_error = NULL
  WHERE id = p_job_id AND lease_owner = p_worker AND status = 'running'
  RETURNING attempts INTO v_attempt;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE job_attempts SET outcome = 'succeeded', finished_at = now() WHERE job_id = p_job_id AND attempt = v_attempt;
  RETURN true;
END $$;

-- p_retry=false marks the job terminally failed (e.g. unsupported input).
CREATE OR REPLACE FUNCTION public.fail_job(p_job_id uuid, p_worker text, p_error text, p_retry boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_job jobs%ROWTYPE; v_status text;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND lease_owner = p_worker AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_leased'; END IF;
  v_status := CASE WHEN NOT p_retry THEN 'failed' WHEN v_job.attempts >= v_job.max_attempts THEN 'dead' ELSE 'queued' END;
  UPDATE jobs SET status = v_status, last_error = left(p_error, 1000), lease_owner = NULL, lease_expires_at = NULL,
    run_after = CASE WHEN v_status = 'queued' THEN now() + (interval '30 seconds' * power(2, v_job.attempts - 1)) ELSE run_after END,
    finished_at = CASE WHEN v_status = 'queued' THEN NULL ELSE now() END,
    updated_at = now()
  WHERE id = p_job_id;
  UPDATE job_attempts SET outcome = CASE v_status WHEN 'queued' THEN 'retry' ELSE v_status END,
    finished_at = now(), error = left(p_error, 1000)
  WHERE job_id = p_job_id AND attempt = v_job.attempts;
  RETURN v_status;
END $$;

-- Cancel queued work for a principal/workspace (e.g. membership removed).
CREATE OR REPLACE FUNCTION public.cancel_jobs_for_principal(p_workspace_id uuid, p_principal_id uuid, p_reason text)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH c AS (
    UPDATE jobs SET status = 'cancelled', last_error = p_reason, finished_at = now(), updated_at = now()
    WHERE workspace_id = p_workspace_id AND principal_id = p_principal_id AND status = 'queued'
    RETURNING 1
  ) SELECT count(*)::integer FROM c;
$$;

-- Manual retry of a failed/dead job by its principal (the UI "Retry" action).
CREATE OR REPLACE FUNCTION public.retry_my_job(p_job_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH u AS (
    UPDATE jobs SET status = 'queued', attempts = 0, run_after = now(), last_error = NULL, finished_at = NULL, updated_at = now()
    WHERE id = p_job_id AND principal_id = auth.uid() AND status IN ('failed', 'dead')
      AND public.user_is_workspace_member(workspace_id, auth.uid())
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM u);
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.enqueue_job(text, uuid, uuid, jsonb, text, timestamptz, integer)',
    'public.claim_jobs(text, text[], integer, integer)',
    'public.heartbeat_job(uuid, text, integer)',
    'public.complete_job(uuid, text, jsonb)',
    'public.fail_job(uuid, text, text, boolean)',
    'public.cancel_jobs_for_principal(uuid, uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.retry_my_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_my_job(uuid) TO authenticated;

-- Queued jobs of a removed member are cancelled with their membership.
CREATE OR REPLACE FUNCTION public.on_workspace_member_removed_jobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM cancel_jobs_for_principal(OLD.workspace_id, OLD.user_id, 'Workspace membership removed');
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_workspace_member_removed_jobs ON workspace_members;
CREATE TRIGGER trg_workspace_member_removed_jobs
  AFTER DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION public.on_workspace_member_removed_jobs();

-- ---------------------------------------------------------------------------
-- 3. Preferences (navigation, pinned agents, composer send key, panels).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_workspace_preferences (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(preferences) <= 32768),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);
ALTER TABLE user_workspace_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "uwp_own" ON user_workspace_preferences;
CREATE POLICY "uwp_own" ON user_workspace_preferences FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND public.user_is_workspace_member(workspace_id, auth.uid()));

-- Shallow-merges a patch into the caller's preferences for a workspace.
CREATE OR REPLACE FUNCTION public.set_workspace_preferences(p_workspace_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_prefs jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_member(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'Preferences must be an object' USING ERRCODE = '22023'; END IF;
  INSERT INTO user_workspace_preferences (user_id, workspace_id, preferences)
  VALUES (auth.uid(), p_workspace_id, jsonb_strip_nulls(p_patch))
  ON CONFLICT (user_id, workspace_id) DO UPDATE
    SET preferences = jsonb_strip_nulls(user_workspace_preferences.preferences || p_patch), updated_at = now()
  RETURNING preferences INTO v_prefs;
  RETURN v_prefs;
END $$;
REVOKE EXECUTE ON FUNCTION public.set_workspace_preferences(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_workspace_preferences(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Personal sidebar categories. Affect navigation only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sidebar_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  sort_order integer NOT NULL DEFAULT 0,
  collapsed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_sidebar_categories_user ON sidebar_categories (user_id, workspace_id, sort_order);

CREATE TABLE IF NOT EXISTS public.sidebar_category_items (
  category_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id),
  FOREIGN KEY (category_id, workspace_id) REFERENCES sidebar_categories(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE
);

ALTER TABLE sidebar_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE sidebar_category_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sidebar_categories_own" ON sidebar_categories;
CREATE POLICY "sidebar_categories_own" ON sidebar_categories FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND public.user_is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS "sidebar_category_items_own" ON sidebar_category_items;
CREATE POLICY "sidebar_category_items_own" ON sidebar_category_items FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM sidebar_categories c WHERE c.id = category_id AND c.user_id = auth.uid())
    -- Only channels the user can see may be placed in a category.
    AND EXISTS (SELECT 1 FROM channels ch WHERE ch.id = channel_id)
  );

-- ---------------------------------------------------------------------------
-- 5. Channel notification preferences.
-- ---------------------------------------------------------------------------
ALTER TABLE channel_members
  ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_level text NOT NULL DEFAULT 'default';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_members_notify_level_check') THEN
    ALTER TABLE channel_members ADD CONSTRAINT channel_members_notify_level_check
      CHECK (notify_level IN ('default', 'all', 'mentions', 'none'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Thread follows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.thread_follows (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  root_message_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  following boolean NOT NULL DEFAULT true,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, root_message_id),
  FOREIGN KEY (root_message_id, workspace_id) REFERENCES messages(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_thread_follows_user ON thread_follows (user_id, workspace_id) WHERE following;
ALTER TABLE thread_follows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "thread_follows_own" ON thread_follows;
CREATE POLICY "thread_follows_own" ON thread_follows FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.user_is_channel_member(channel_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON thread_follows FROM anon, authenticated;

-- Replying follows the thread for the replier and (if new) its starter.
CREATE OR REPLACE FUNCTION public.on_thread_reply_follow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_root messages%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_root FROM messages WHERE id = NEW.parent_id;
  IF v_root.id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO thread_follows (user_id, root_message_id, workspace_id, channel_id, following, last_read_at)
  VALUES (NEW.user_id, v_root.id, v_root.workspace_id, v_root.channel_id, true, now())
  ON CONFLICT (user_id, root_message_id) DO UPDATE SET last_read_at = now();
  INSERT INTO thread_follows (user_id, root_message_id, workspace_id, channel_id, following, last_read_at)
  VALUES (v_root.user_id, v_root.id, v_root.workspace_id, v_root.channel_id, true, v_root.created_at)
  ON CONFLICT (user_id, root_message_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_thread_reply_follow ON messages;
CREATE TRIGGER trg_thread_reply_follow AFTER INSERT ON messages
  FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL) EXECUTE FUNCTION public.on_thread_reply_follow();

CREATE OR REPLACE FUNCTION public.set_thread_follow(p_root_message_id uuid, p_following boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_root messages%ROWTYPE;
BEGIN
  SELECT * INTO v_root FROM messages WHERE id = p_root_message_id AND parent_id IS NULL;
  IF v_root.id IS NULL OR NOT user_is_channel_member(v_root.channel_id, auth.uid()) THEN
    RAISE EXCEPTION 'Thread not found' USING ERRCODE = '42501';
  END IF;
  INSERT INTO thread_follows (user_id, root_message_id, workspace_id, channel_id, following)
  VALUES (auth.uid(), v_root.id, v_root.workspace_id, v_root.channel_id, p_following)
  ON CONFLICT (user_id, root_message_id) DO UPDATE SET following = p_following;
END $$;

CREATE OR REPLACE FUNCTION public.mark_thread_read(p_root_message_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE thread_follows SET last_read_at = now()
  WHERE user_id = auth.uid() AND root_message_id = p_root_message_id;
$$;

-- Followed threads with reply/unread counts, newest activity first.
CREATE OR REPLACE FUNCTION public.get_followed_threads(p_workspace_id uuid, p_limit integer DEFAULT 30, p_before timestamptz DEFAULT NULL)
RETURNS TABLE(root_message_id uuid, channel_id uuid, root_user_id uuid, root_content text, root_created_at timestamptz,
  reply_count bigint, unread_count bigint, last_reply_at timestamptz, participants uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT f.root_message_id, r.channel_id, r.user_id, left(r.content, 500), r.created_at,
    count(m.id), count(m.id) FILTER (WHERE m.created_at > f.last_read_at AND m.user_id <> auth.uid()),
    max(m.created_at),
    (array_agg(DISTINCT m.user_id))[1:5]
  FROM thread_follows f
  JOIN messages r ON r.id = f.root_message_id AND r.deleted_at IS NULL
  JOIN messages m ON m.parent_id = r.id AND m.deleted_at IS NULL
  WHERE f.user_id = auth.uid() AND f.workspace_id = p_workspace_id AND f.following
    AND user_is_channel_member(r.channel_id, auth.uid())
  GROUP BY f.root_message_id, r.channel_id, r.user_id, r.content, r.created_at, f.last_read_at
  HAVING p_before IS NULL OR max(m.created_at) < p_before
  ORDER BY max(m.created_at) DESC
  LIMIT least(p_limit, 100);
$$;

REVOKE EXECUTE ON FUNCTION public.set_thread_follow(uuid, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mark_thread_read(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_followed_threads(uuid, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_thread_follow(uuid, boolean), public.mark_thread_read(uuid),
  public.get_followed_threads(uuid, integer, timestamptz) TO authenticated;

-- Backfill follows for existing threads (rerunnable).
INSERT INTO thread_follows (user_id, root_message_id, workspace_id, channel_id, following, last_read_at)
SELECT DISTINCT ON (m.user_id, r.id) m.user_id, r.id, r.workspace_id, r.channel_id, true, now()
FROM messages m JOIN messages r ON r.id = m.parent_id
WHERE m.deleted_at IS NULL
ON CONFLICT (user_id, root_message_id) DO NOTHING;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
