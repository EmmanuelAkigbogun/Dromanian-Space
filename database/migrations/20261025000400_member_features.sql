-- ============================================================================
-- 20261025000400_member_features.sql
-- ----------------------------------------------------------------------------
-- Owners and admins choose which parts of the app the rest of the team sees
-- (Settings → Features). Admins always see everything. Hidden AI is enforced
-- here: members cannot start agent runs or AI sessions; other features are
-- hidden from navigation and their pages.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.workspace_member_features (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  hidden text[] NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (hidden <@ ARRAY['ai', 'crm', 'drive', 'calendar', 'projects', 'automation']::text[])
);
ALTER TABLE workspace_member_features ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workspace_member_features_read" ON workspace_member_features;
CREATE POLICY "workspace_member_features_read" ON workspace_member_features FOR SELECT TO authenticated
  USING (public.user_is_workspace_member(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON workspace_member_features FROM anon, authenticated;
GRANT SELECT ON workspace_member_features TO authenticated;

CREATE OR REPLACE FUNCTION public.feature_visible_to(p_workspace_id uuid, p_user_id uuid, p_feature text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT user_is_workspace_admin(p_workspace_id, p_user_id)
      OR NOT coalesce((SELECT p_feature = ANY(hidden) FROM workspace_member_features WHERE workspace_id = p_workspace_id), false);
$$;

CREATE OR REPLACE FUNCTION public.set_member_features(p_workspace_id uuid, p_hidden text[])
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hidden text[] := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_hidden, '{}')) x ORDER BY x);
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace owners and admins can change features' USING ERRCODE = '42501';
  END IF;
  INSERT INTO workspace_member_features (workspace_id, hidden, updated_by, updated_at)
  VALUES (p_workspace_id, v_hidden, auth.uid(), now())
  ON CONFLICT (workspace_id) DO UPDATE SET hidden = EXCLUDED.hidden, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, metadata)
  VALUES (p_workspace_id, auth.uid(), 'member_features_changed', 'workspace', jsonb_build_object('hidden', v_hidden));
  RETURN v_hidden;
END $$;

-- Every agent run (chat, mentions, sessions, automations) goes through agent_runs.
CREATE OR REPLACE FUNCTION public.agent_runs_require_ai_feature() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT feature_visible_to(NEW.workspace_id, NEW.requested_by, 'ai') THEN
    RAISE EXCEPTION 'AI is not available in this workspace yet' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_agent_runs_require_ai_feature ON agent_runs;
CREATE TRIGGER trg_agent_runs_require_ai_feature BEFORE INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.agent_runs_require_ai_feature();

CREATE OR REPLACE FUNCTION public.ai_sessions_require_ai_feature() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT feature_visible_to(NEW.workspace_id, NEW.started_by, 'ai') THEN
    RAISE EXCEPTION 'AI is not available in this workspace yet' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ai_sessions_require_ai_feature ON conversation_ai_sessions;
CREATE TRIGGER trg_ai_sessions_require_ai_feature BEFORE INSERT ON conversation_ai_sessions
  FOR EACH ROW EXECUTE FUNCTION public.ai_sessions_require_ai_feature();

REVOKE EXECUTE ON FUNCTION public.feature_visible_to(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_visible_to(uuid, uuid, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_member_features(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_features(uuid, text[]) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.agent_runs_require_ai_feature() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ai_sessions_require_ai_feature() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
