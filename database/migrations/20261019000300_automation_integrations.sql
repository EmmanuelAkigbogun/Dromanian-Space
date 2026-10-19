-- ============================================================================
-- 20261019000300_automation_integrations.sql
-- ----------------------------------------------------------------------------
-- Optional external workflow automation (n8n). Core features never depend on
-- it: agent conversations, internal scheduled jobs and CRM work without it.
--   * automation_keys: per-workspace signing keys created by an admin. Runs
--     started with a key act as the admin who created it (their current
--     access, re-checked on every run). The HMAC secret is readable only by
--     the server (service role) and shown once at creation.
--   * automation_requests: one row per external request, unique per key and
--     caller-supplied request id, so retried deliveries never start a second
--     run. Doubles as the execution log (status, callback delivery, errors).
--   * Callbacks are delivered by the worker as jobs (timeouts, retries with
--     backoff, dead-letter), never inline in a request.
-- Internal scheduling stays with pg_cron / the worker; n8n only starts agent
-- runs through this API, so the two never execute the same work.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.automation_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'n8n' CHECK (provider IN ('n8n')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  principal_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  secret text NOT NULL CHECK (length(secret) >= 32),
  -- Empty: any agent the principal can use. Otherwise only these agents.
  allowed_agent_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_keys_workspace ON automation_keys (workspace_id) WHERE revoked_at IS NULL;
ALTER TABLE automation_keys ENABLE ROW LEVEL SECURITY;
-- No policies: clients never read this table (the list RPC omits secrets).
REVOKE ALL ON automation_keys FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.automation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  key_id uuid NOT NULL,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 8 AND 120),
  agent_id uuid,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  callback_url text CHECK (callback_url IS NULL OR callback_url ~ '^https?://'),
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'rejected', 'delivered', 'delivery_failed', 'no_callback')),
  error text,
  delivery_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (key_id, request_key),
  FOREIGN KEY (key_id, workspace_id) REFERENCES automation_keys(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_requests_run ON automation_requests (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_requests_recent ON automation_requests (workspace_id, created_at DESC);
ALTER TABLE automation_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "automation_requests_admin_read" ON automation_requests;
CREATE POLICY "automation_requests_admin_read" ON automation_requests FOR SELECT TO authenticated
  USING (public.user_is_workspace_admin(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON automation_requests FROM anon, authenticated;
GRANT SELECT ON automation_requests TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin RPCs (caller checked inside)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.automation_key_create(p_workspace_id uuid, p_name text, p_agent_ids uuid[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_secret text;
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can create automation keys' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_agent_ids, '{}')) a(id)
             WHERE NOT EXISTS (SELECT 1 FROM workspace_agents w WHERE w.id = a.id AND w.workspace_id = p_workspace_id AND w.archived_at IS NULL)) THEN
    RAISE EXCEPTION 'Choose agents from this workspace' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM automation_keys WHERE workspace_id = p_workspace_id AND revoked_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'A workspace can have at most 20 active automation keys' USING ERRCODE = '53400';
  END IF;
  v_secret := encode(gen_random_bytes(32), 'hex');
  INSERT INTO automation_keys (workspace_id, name, principal_id, secret, allowed_agent_ids, created_by)
  VALUES (p_workspace_id, btrim(p_name), auth.uid(), v_secret, coalesce(p_agent_ids, '{}'), auth.uid())
  RETURNING id INTO v_id;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, auth.uid(), 'automation_key_created', 'automation_key', v_id, jsonb_build_object('name', btrim(p_name)));
  -- The secret is returned once and never again.
  RETURN jsonb_build_object('id', v_id, 'secret', v_secret);
END $$;

CREATE OR REPLACE FUNCTION public.automation_key_revoke(p_key_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM automation_keys WHERE id = p_key_id;
  IF v_ws IS NULL OR auth.uid() IS NULL OR NOT user_is_workspace_admin(v_ws, auth.uid()) THEN
    RAISE EXCEPTION 'Automation key not found' USING ERRCODE = '42501';
  END IF;
  UPDATE automation_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = p_key_id;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (v_ws, auth.uid(), 'automation_key_revoked', 'automation_key', p_key_id, '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.automation_keys_list(p_workspace_id uuid)
RETURNS TABLE(id uuid, name text, provider text, principal_id uuid, principal_name text, allowed_agent_ids uuid[],
              created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz, requests_24h bigint, failures_24h bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can view automation keys' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT k.id, k.name, k.provider, k.principal_id, coalesce(p.display_name, p.username, 'Member'), k.allowed_agent_ids,
         k.created_at, k.last_used_at, k.revoked_at,
         (SELECT count(*) FROM automation_requests r WHERE r.key_id = k.id AND r.created_at > now() - interval '24 hours'),
         (SELECT count(*) FROM automation_requests r WHERE r.key_id = k.id AND r.created_at > now() - interval '24 hours'
            AND r.status IN ('rejected', 'delivery_failed'))
  FROM automation_keys k LEFT JOIN profiles p ON p.id = k.principal_id
  WHERE k.workspace_id = p_workspace_id
  ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC;
END $$;

-- ---------------------------------------------------------------------------
-- Server RPCs (service role only)
-- ---------------------------------------------------------------------------
-- Signature verification material for the API. Revoked keys and keys whose
-- principal left the workspace are returned as inactive.
CREATE OR REPLACE FUNCTION public.automation_key_for(p_key_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('id', k.id, 'workspace_id', k.workspace_id, 'principal_id', k.principal_id, 'secret', k.secret,
    'allowed_agent_ids', to_jsonb(k.allowed_agent_ids),
    'active', k.revoked_at IS NULL AND user_is_workspace_member(k.workspace_id, k.principal_id))
  FROM automation_keys k WHERE k.id = p_key_id;
$$;

-- Records an external request and starts the agent run exactly once per
-- (key, request_key). Returns the existing run for a repeated request.
CREATE OR REPLACE FUNCTION public.automation_start_run(p_key_id uuid, p_request_key text, p_agent_handle text,
  p_message text, p_callback_url text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_key automation_keys%ROWTYPE; v_req automation_requests%ROWTYPE; v_agent workspace_agents%ROWTYPE; v_started jsonb;
BEGIN
  SELECT * INTO v_key FROM automation_keys WHERE id = p_key_id;
  IF v_key.id IS NULL OR v_key.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Automation key is not active' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM automation_requests WHERE key_id = p_key_id AND request_key = p_request_key;
  IF v_req.id IS NOT NULL THEN
    RETURN jsonb_build_object('request_id', v_req.id, 'run_id', v_req.run_id, 'status', v_req.status, 'reused', true,
      'error', v_req.error);
  END IF;

  SELECT * INTO v_agent FROM workspace_agents
  WHERE workspace_id = v_key.workspace_id AND handle = lower(btrim(p_agent_handle, ' @')) AND archived_at IS NULL;
  IF v_agent.id IS NULL OR (cardinality(v_key.allowed_agent_ids) > 0 AND NOT v_agent.id = ANY(v_key.allowed_agent_ids)) THEN
    RAISE EXCEPTION 'This key cannot use that agent' USING ERRCODE = '42501';
  END IF;

  INSERT INTO automation_requests (workspace_id, key_id, request_key, agent_id, callback_url)
  VALUES (v_key.workspace_id, p_key_id, p_request_key, v_agent.id, p_callback_url)
  ON CONFLICT (key_id, request_key) DO NOTHING
  RETURNING * INTO v_req;
  IF v_req.id IS NULL THEN
    -- A concurrent duplicate won the race.
    SELECT * INTO v_req FROM automation_requests WHERE key_id = p_key_id AND request_key = p_request_key;
    RETURN jsonb_build_object('request_id', v_req.id, 'run_id', v_req.run_id, 'status', v_req.status, 'reused', true);
  END IF;

  -- Membership, agent visibility, AI settings, quotas and concurrency are
  -- all enforced by agent_start_run for the key's principal.
  v_started := agent_start_run(v_key.principal_id, v_key.workspace_id, v_agent.id, NULL, p_message, '{}'::jsonb,
    'automation', jsonb_build_object('type', 'automation', 'provider', v_key.provider, 'key_id', v_key.id),
    '{"type":"private"}'::jsonb, 'automation:' || p_key_id || ':' || p_request_key, 20000);
  UPDATE automation_requests SET run_id = (v_started ->> 'run_id')::uuid WHERE id = v_req.id;
  UPDATE automation_keys SET last_used_at = now() WHERE id = p_key_id;
  RETURN v_started || jsonb_build_object('request_id', v_req.id, 'agent_id', v_agent.id, 'principal_id', v_key.principal_id,
    'workspace_id', v_key.workspace_id);
END $$;

-- Requests that failed validation are logged for the admin (no run).
CREATE OR REPLACE FUNCTION public.automation_log_rejection(p_key_id uuid, p_request_key text, p_error text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO automation_requests (workspace_id, key_id, request_key, status, error, finished_at)
  SELECT k.workspace_id, k.id, p_request_key, 'rejected', left(p_error, 500), now()
  FROM automation_keys k WHERE k.id = p_key_id AND length(p_request_key) BETWEEN 8 AND 120
  ON CONFLICT (key_id, request_key) DO NOTHING;
$$;

-- The callback (if any) for a finished run, with what the payload needs.
CREATE OR REPLACE FUNCTION public.automation_callback_for_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('request_id', r.id, 'request_key', r.request_key, 'key_id', r.key_id, 'workspace_id', r.workspace_id,
    'callback_url', r.callback_url, 'status', r.status)
  FROM automation_requests r WHERE r.run_id = p_run_id;
$$;

CREATE OR REPLACE FUNCTION public.automation_record_delivery(p_request_id uuid, p_status text, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF p_status NOT IN ('delivered', 'delivery_failed', 'no_callback') THEN
    RAISE EXCEPTION 'Invalid delivery status' USING ERRCODE = '22023';
  END IF;
  UPDATE automation_requests SET status = p_status, error = left(p_error, 500), finished_at = now(),
    delivery_attempts = delivery_attempts + CASE WHEN p_status = 'no_callback' THEN 0 ELSE 1 END
  WHERE id = p_request_id;
END $$;

REVOKE ALL ON FUNCTION public.automation_key_create(uuid, text, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.automation_key_revoke(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.automation_keys_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.automation_key_create(uuid, text, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.automation_key_revoke(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.automation_keys_list(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.automation_key_for(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_start_run(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_log_rejection(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_callback_for_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_record_delivery(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_key_for(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_start_run(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_log_rejection(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_callback_for_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.automation_record_delivery(uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
