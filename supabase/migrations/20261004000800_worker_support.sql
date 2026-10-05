-- ============================================================================
-- 20261004000800_worker_support.sql
-- ----------------------------------------------------------------------------
-- Database side of the server workers (server/ and api/):
--   * Drive purge and storage garbage collection (objects are deleted only
--     when nothing references them any more), abandoned upload cleanup.
--   * Embedding failure state for knowledge sources.
--   * Targeted job claims (a request may process the work it just queued).
--   * Agent mentions: resolving a chat message to the agents it addresses,
--     publishing an audience-safe reply under the workspace reply policy,
--     and conversation history that respects current source access.
-- Every function here is service-only unless stated otherwise.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Drive purge / GC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_object_unreferenced(p_bucket text, p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT CASE p_bucket
    WHEN 'drive' THEN NOT EXISTS (
      SELECT 1 FROM drive_versions WHERE storage_bucket = 'drive' AND storage_path = p_path AND status IN ('pending', 'ready'))
    WHEN 'message-attachments' THEN storage_attachment_unreferenced(p_path)
    ELSE false END;
$$;

-- Deletes the rows of an item group whose owner asked for permanent deletion
-- and queues removal of storage objects nothing else references.
CREATE OR REPLACE FUNCTION public.drive_purge_execute(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_ws uuid; v_objects jsonb; v_items integer; v_queued integer := 0; o jsonb;
BEGIN
  SELECT workspace_id INTO v_ws FROM drive_items WHERE id = p_item_id AND purge_requested_at IS NOT NULL;
  IF v_ws IS NULL THEN RETURN jsonb_build_object('status', 'nothing_to_purge'); END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.purge_items (id uuid PRIMARY KEY) ON COMMIT DROP;
  DELETE FROM pg_temp.purge_items;
  INSERT INTO pg_temp.purge_items SELECT id FROM drive_items WHERE trash_root_id = p_item_id AND purge_requested_at IS NOT NULL;

  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('bucket', v.storage_bucket, 'path', v.storage_path)), '[]'::jsonb)
  INTO v_objects
  FROM drive_versions v WHERE v.item_id IN (SELECT id FROM pg_temp.purge_items);

  -- Items trashed separately (their own trash group) survive at the top level.
  UPDATE drive_items SET parent_id = NULL
  WHERE parent_id IN (SELECT id FROM pg_temp.purge_items) AND id NOT IN (SELECT id FROM pg_temp.purge_items);

  DELETE FROM drive_items WHERE id IN (SELECT id FROM pg_temp.purge_items);
  GET DIAGNOSTICS v_items = ROW_COUNT;

  FOR o IN SELECT * FROM jsonb_array_elements(v_objects) LOOP
    IF drive_object_unreferenced(o ->> 'bucket', o ->> 'path') THEN
      PERFORM enqueue_job('drive.gc_object', v_ws, NULL, o, 'gc:' || (o ->> 'bucket') || ':' || (o ->> 'path'));
      v_queued := v_queued + 1;
    END IF;
  END LOOP;

  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (v_ws, NULL, 'drive_item_purged', 'drive_item', p_item_id, jsonb_build_object('items', v_items, 'objects_queued', v_queued));
  RETURN jsonb_build_object('status', 'purged', 'items', v_items, 'objects_queued', v_queued);
END $$;

-- Pending uploads older than a day are abandoned; their objects are collected.
CREATE OR REPLACE FUNCTION public.drive_cleanup_abandoned_uploads()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN
    UPDATE drive_versions SET status = 'abandoned'
    WHERE status = 'pending' AND created_at < now() - interval '24 hours'
    RETURNING id, item_id, workspace_id, storage_bucket, storage_path
  LOOP
    DELETE FROM drive_items i WHERE i.id = r.item_id AND i.current_version_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM drive_versions v WHERE v.item_id = i.id AND v.status = 'ready');
    IF r.storage_bucket = 'drive' THEN
      PERFORM enqueue_job('drive.gc_object', r.workspace_id, NULL,
        jsonb_build_object('bucket', r.storage_bucket, 'path', r.storage_path), 'gc:drive:' || r.storage_path);
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- Knowledge: embeddings are optional, keyword retrieval works without them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.knowledge_mark_embedding_failed(p_source_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE knowledge_sources SET embedding_status = 'failed',
    status = CASE WHEN status = 'indexing' THEN 'ready' ELSE status END, updated_at = now()
  WHERE id = p_source_id AND superseded_at IS NULL;
$$;

-- ---------------------------------------------------------------------------
-- Targeted job claims
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_workspace_jobs(
  p_worker text, p_workspace_id uuid, p_kinds text[] DEFAULT NULL, p_limit integer DEFAULT 5, p_lease_seconds integer DEFAULT 120
) RETURNS SETOF jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM jobs j
    WHERE j.status = 'queued' AND j.run_after <= now() AND j.workspace_id = p_workspace_id
      AND (p_kinds IS NULL OR j.kind = ANY(p_kinds))
    ORDER BY j.run_after, j.created_at
    LIMIT greatest(1, least(p_limit, 20))
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

-- Claims one job by its idempotency key even if it is scheduled slightly in
-- the future (documents debounce for 20 seconds; an explicit request may skip it).
CREATE OR REPLACE FUNCTION public.claim_job_by_key(p_worker text, p_kind text, p_key text, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM jobs j
    WHERE j.kind = p_kind AND j.idempotency_key = p_key AND j.status = 'queued'
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

-- ---------------------------------------------------------------------------
-- Agent replies in conversations
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_ai_settings ADD COLUMN IF NOT EXISTS mention_reply_policy text NOT NULL DEFAULT 'review';
ALTER TABLE workspace_ai_settings DROP CONSTRAINT IF EXISTS workspace_ai_settings_mention_reply_policy_check;
ALTER TABLE workspace_ai_settings ADD CONSTRAINT workspace_ai_settings_mention_reply_policy_check
  CHECK (mention_reply_policy IN ('review', 'auto'));
COMMENT ON COLUMN workspace_ai_settings.mention_reply_policy IS
  'review: a mention reply becomes a review card for the person who mentioned the agent. auto: published when every source it used is visible to the whole conversation (admin-configured policy).';

CREATE OR REPLACE FUNCTION public.ai_update_settings(p_workspace_id uuid, p_patch jsonb)
RETURNS workspace_ai_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v workspace_ai_settings%ROWTYPE;
BEGIN
  IF NOT user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can change AI settings' USING ERRCODE = '42501';
  END IF;
  PERFORM ai_settings_for(p_workspace_id);
  UPDATE workspace_ai_settings SET
    enabled = coalesce((p_patch ->> 'enabled')::boolean, enabled),
    default_model = coalesce(p_patch ->> 'default_model', default_model),
    allowed_models = coalesce(ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'allowed_models')), allowed_models),
    monthly_token_budget = CASE WHEN p_patch ? 'monthly_token_budget' THEN (p_patch ->> 'monthly_token_budget')::bigint ELSE monthly_token_budget END,
    per_user_daily_token_budget = CASE WHEN p_patch ? 'per_user_daily_token_budget' THEN (p_patch ->> 'per_user_daily_token_budget')::bigint ELSE per_user_daily_token_budget END,
    max_concurrent_runs = coalesce((p_patch ->> 'max_concurrent_runs')::integer, max_concurrent_runs),
    web_research_enabled = coalesce((p_patch ->> 'web_research_enabled')::boolean, web_research_enabled),
    mention_reply_policy = coalesce(p_patch ->> 'mention_reply_policy', mention_reply_policy),
    updated_by = auth.uid(), updated_at = now()
  WHERE workspace_id = p_workspace_id RETURNING * INTO v;
  IF NOT v.default_model = ANY(v.allowed_models) THEN
    RAISE EXCEPTION 'The default model must be one of the allowed models' USING ERRCODE = '22023';
  END IF;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, auth.uid(), 'ai_settings_changed', 'workspace', p_workspace_id, p_patch);
  RETURN v;
END $$;

-- The agents a chat message addresses with @handle, after every check that
-- makes the mention a valid trigger: the caller wrote it (recently), it is not
-- an agent post (no agent-to-agent loops), the caller is still in the
-- conversation, and each agent is active and visible to them. At most 3.
CREATE OR REPLACE FUNCTION public.agent_mention_targets(p_actor uuid, p_message_id uuid)
RETURNS TABLE(agent_id uuid, handle text, agent_name text, workspace_id uuid, channel_id uuid, thread_root_id uuid,
  content text, is_direct boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_msg messages%ROWTYPE;
BEGIN
  SELECT * INTO v_msg FROM messages WHERE id = p_message_id;
  IF v_msg.id IS NULL OR v_msg.user_id IS DISTINCT FROM p_actor OR v_msg.agent_id IS NOT NULL OR v_msg.deleted_at IS NOT NULL
     OR v_msg.created_at < now() - interval '15 minutes' OR NOT user_is_channel_member(v_msg.channel_id, p_actor) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT a.id, a.handle, a.name, v_msg.workspace_id, v_msg.channel_id, coalesce(v_msg.parent_id, v_msg.id), v_msg.content,
    EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.channel_id = v_msg.channel_id)
  FROM (
    SELECT DISTINCT lower(m[1]) AS h
    FROM regexp_matches(coalesce(v_msg.content, ''), '(?:^|[^A-Za-z0-9_.-])@([A-Za-z][A-Za-z0-9-]{2,39})', 'g') AS m
  ) mentions
  JOIN workspace_agents a ON a.workspace_id = v_msg.workspace_id AND a.handle = mentions.h
  WHERE a.status = 'active' AND agent_visible_to(a.id, p_actor)
  ORDER BY a.handle
  LIMIT 3;
END $$;

-- Publishes (or proposes) a run's final answer into its destination
-- conversation. The answer is never published when someone in that
-- conversation could not open a source the run used; it stays private.
CREATE OR REPLACE FUNCTION public.agent_publish_reply(p_run_id uuid, p_content text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run agent_runs%ROWTYPE; v_settings workspace_ai_settings%ROWTYPE; v_args jsonb; v_gaps jsonb; v_id uuid;
  v_result jsonb; v_channel uuid; v_parent uuid; v_auto boolean;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RETURN jsonb_build_object('status', 'not_running'); END IF;
  IF coalesce(v_run.destination ->> 'type', 'private') <> 'channel' THEN RETURN jsonb_build_object('status', 'private'); END IF;
  IF length(btrim(coalesce(p_content, ''))) = 0 THEN RETURN jsonb_build_object('status', 'empty'); END IF;
  v_channel := (v_run.destination ->> 'channel_id')::uuid;
  v_parent := nullif(v_run.destination ->> 'parent_id', '')::uuid;
  IF NOT user_is_channel_member(v_channel, v_run.requested_by) THEN
    RETURN jsonb_build_object('status', 'private', 'reason', 'not_member');
  END IF;
  v_args := jsonb_build_object('channel_id', v_channel, 'parent_id', v_parent, 'content', left(p_content, 20000));
  v_gaps := agent_audience_gaps(p_run_id, agent_action_audience(v_run.workspace_id, v_run.requested_by, 'post_message', v_args));
  IF jsonb_array_length(v_gaps) > 0 THEN
    PERFORM agent_add_event(p_run_id, 'warning', jsonb_build_object('code', 'kept_private',
      'message', 'Some people in this conversation cannot open sources this answer used, so it was kept private.',
      'sources', v_gaps));
    RETURN jsonb_build_object('status', 'private', 'reason', 'audience', 'sources', v_gaps);
  END IF;
  v_settings := ai_settings_for(v_run.workspace_id);
  v_auto := v_settings.mention_reply_policy = 'auto';
  INSERT INTO agent_action_proposals (workspace_id, run_id, conversation_id, action_type, arguments, arguments_hash, summary,
                                      destination, requested_for, idempotency_key, status)
  VALUES (v_run.workspace_id, p_run_id, v_run.conversation_id, 'post_message', v_args, agent_hash_arguments(v_args),
          'Reply in the conversation where the agent was mentioned',
          jsonb_build_object('type', 'channel', 'channel_id', v_channel, 'parent_id', v_parent),
          v_run.requested_by, 'reply:' || p_run_id, CASE WHEN v_auto THEN 'executing' ELSE 'pending' END)
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('status', 'exists'); END IF;
  IF NOT v_auto THEN
    RETURN jsonb_build_object('status', 'proposed', 'proposal_id', v_id);
  END IF;
  BEGIN
    v_result := agent_execute_proposal(v_id);
    UPDATE agent_action_proposals SET status = 'executed', executed_at = now(), result = v_result,
      decided_by = v_run.requested_by, decided_at = now()
    WHERE id = v_id;
    INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (v_run.workspace_id, v_run.requested_by, 'agent_reply_published', 'agent_proposal', v_id,
            jsonb_build_object('policy', 'auto', 'run_id', p_run_id, 'result', v_result));
    RETURN jsonb_build_object('status', 'published', 'proposal_id', v_id, 'result', v_result);
  EXCEPTION WHEN OTHERS THEN
    UPDATE agent_action_proposals SET status = 'failed', error = left(SQLERRM, 500) WHERE id = v_id;
    RETURN jsonb_build_object('status', 'failed', 'error', left(SQLERRM, 200));
  END;
END $$;

-- A past answer stays usable only while its requester can still open every
-- source the run read (files and conversations), not just the cited ones.
CREATE OR REPLACE FUNCTION public.agent_run_sources_visible(p_run_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_run_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM agent_run_sources s
    WHERE s.run_id = p_run_id
      AND ((s.kind = 'drive_item' AND NOT drive_viewable_by(s.item_id, p_user_id))
        OR (s.kind = 'channel' AND NOT user_is_channel_member(s.channel_id, p_user_id))
        OR (s.kind = 'task' AND NOT task_visible_to(s.ref_id::uuid, p_user_id))));
$$;

CREATE OR REPLACE FUNCTION public.agent_message_sources_visible(p_message_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_user_id = auth.uid()
    AND NOT EXISTS (SELECT 1 FROM agent_citations c WHERE c.message_id = p_message_id AND NOT drive_viewable_by(c.item_id, p_user_id))
    AND agent_run_sources_visible((SELECT m.run_id FROM agent_messages m WHERE m.id = p_message_id AND m.role = 'assistant'), p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.agent_conversation_timeline(p_conversation_id uuid)
RETURNS TABLE(id uuid, role text, content text, status text, run_id uuid, branch_of uuid, scope jsonb, created_at timestamptz,
  redacted boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT t.id, t.role,
    CASE WHEN t.hidden THEN 'This answer used sources you can no longer open, so it is hidden.' ELSE t.content END,
    t.status, t.run_id, t.branch_of, t.scope, t.created_at, t.hidden
  FROM (
    SELECT m.*, (m.role = 'assistant' AND (
        EXISTS (SELECT 1 FROM agent_citations c WHERE c.message_id = m.id AND NOT drive_viewable_by(c.item_id, auth.uid()))
        OR NOT agent_run_sources_visible(m.run_id, auth.uid()))) AS hidden
    FROM agent_messages m JOIN agent_conversations cv ON cv.id = m.conversation_id
    WHERE m.conversation_id = p_conversation_id AND cv.created_by = auth.uid()
      AND user_is_workspace_member(cv.workspace_id, auth.uid())
  ) t
  ORDER BY t.created_at, CASE t.role WHEN 'user' THEN 0 ELSE 1 END;
$$;

-- Earlier turns of a run's conversation, as text, for replay to the model.
-- Answers whose sources the requester can no longer open are left out.
CREATE OR REPLACE FUNCTION public.agent_history_for(p_run_id uuid, p_limit integer DEFAULT 24)
RETURNS TABLE(role text, content text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT h.role, h.content, h.created_at FROM (
    SELECT m.role, m.content, m.created_at, CASE m.role WHEN 'user' THEN 0 ELSE 1 END AS ord
    FROM agent_runs r
    JOIN agent_messages m ON m.conversation_id = r.conversation_id AND m.run_id IS DISTINCT FROM r.id
    WHERE r.id = p_run_id
      AND m.created_at <= r.created_at
      AND length(btrim(m.content)) > 0
      AND (m.role = 'user' OR (
        m.status IN ('complete', 'interrupted', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM agent_citations c WHERE c.message_id = m.id AND NOT drive_viewable_by(c.item_id, r.requested_by))
        AND agent_run_sources_visible(m.run_id, r.requested_by)))
    ORDER BY m.created_at DESC, ord DESC
    LIMIT least(greatest(p_limit, 0), 60)
  ) h ORDER BY h.created_at, h.ord;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.drive_object_unreferenced(text, text)', 'public.drive_purge_execute(uuid)',
    'public.drive_cleanup_abandoned_uploads()', 'public.knowledge_mark_embedding_failed(uuid)',
    'public.claim_workspace_jobs(text, uuid, text[], integer, integer)', 'public.claim_job_by_key(text, text, text, integer)',
    'public.agent_mention_targets(uuid, uuid)', 'public.agent_publish_reply(uuid, text)',
    'public.agent_run_sources_visible(uuid, uuid)', 'public.agent_history_for(uuid, integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.ai_update_settings(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_update_settings(uuid, jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.agent_conversation_timeline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_conversation_timeline(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_message_sources_visible(uuid, uuid) TO authenticated;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drive-cleanup-abandoned-uploads') THEN
    PERFORM cron.schedule('drive-cleanup-abandoned-uploads', '17 * * * *', 'SELECT public.drive_cleanup_abandoned_uploads();');
  END IF;
END $$;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
