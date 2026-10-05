-- ============================================================================
-- 20261004000700_agent_tools_and_search.sql
-- ----------------------------------------------------------------------------
-- Read operations used by agent tools, each taking an explicit actor (the
-- run's verified requester) and enforcing that actor's current access inside
-- SQL. They are callable only by the server (service_role). The same search
-- is exposed to clients through search_workspace(), where the actor is always
-- the signed-in user.
-- ============================================================================

-- Mirrors the tasks_select policy for an arbitrary actor.
CREATE OR REPLACE FUNCTION public.task_visible_to(p_task_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = p_task_id AND t.deleted_at IS NULL AND user_is_workspace_member(t.workspace_id, p_user_id)
      AND (t.created_by = p_user_id OR is_task_assignee(t.id, p_user_id)
           OR (t.project_id IS NOT NULL AND is_project_readable(t.project_id, p_user_id))
           OR user_is_workspace_admin(t.workspace_id, p_user_id)));
$$;

-- Unified search across messages, channels, people, files and documents,
-- tasks and agents for one actor. Empty results reveal nothing.
DROP FUNCTION IF EXISTS public.search_workspace(uuid, text, text[], integer);
DROP FUNCTION IF EXISTS public.search_workspace_for(uuid, uuid, text, text[], integer);
CREATE OR REPLACE FUNCTION public.search_workspace_for(
  p_actor uuid, p_workspace_id uuid, p_query text, p_types text[] DEFAULT NULL, p_limit integer DEFAULT 20
) RETURNS TABLE(result_type text, id uuid, title text, snippet text, link text, context text, created_at timestamptz, rank real,
  channel_id uuid, item_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_tsq tsquery; v_like text;
BEGIN
  IF p_actor IS NULL OR NOT user_is_workspace_member(p_workspace_id, p_actor) OR length(btrim(coalesce(p_query, ''))) < 2 THEN
    RETURN;
  END IF;
  SELECT to_tsquery('simple', string_agg(quote_literal(lex) || ':*', ' & '))
  INTO v_tsq FROM unnest(tsvector_to_array(to_tsvector('english', p_query))) AS lex;
  v_like := '%' || replace(replace(lower(btrim(p_query)), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT * FROM (
    -- Messages in conversations the actor belongs to
    SELECT 'message'::text, m.id,
      coalesce(pr.display_name, pr.username, 'Someone')::text,
      left(m.content, 300)::text,
      CASE WHEN dc.id IS NOT NULL THEN '/dm/' || dc.id || '?message=' || m.id
           ELSE '/channels/' || c.slug || '?message=' || m.id END,
      CASE WHEN dc.id IS NOT NULL THEN 'Direct message' ELSE '#' || c.name END,
      m.created_at,
      ts_rank(to_tsvector('english', coalesce(m.content, '')), v_tsq), m.channel_id, NULL::uuid
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN direct_conversations dc ON dc.channel_id = c.id
    LEFT JOIN profiles pr ON pr.id = m.user_id
    WHERE (p_types IS NULL OR 'message' = ANY(p_types))
      AND m.workspace_id = p_workspace_id AND m.deleted_at IS NULL
      AND v_tsq IS NOT NULL AND to_tsvector('english', coalesce(m.content, '')) @@ v_tsq  -- matches idx_messages_content_fts
      AND user_is_channel_member(m.channel_id, p_actor)
    UNION ALL
    -- Channels: public ones and private ones the actor is in
    SELECT 'channel', c.id, c.name, coalesce(c.topic, c.description, '')::text, '/channels/' || c.slug,
      CASE WHEN c.is_private THEN 'Private channel' ELSE 'Channel' END, c.created_at, 1.0::real, c.id, NULL::uuid
    FROM channels c
    WHERE (p_types IS NULL OR 'channel' = ANY(p_types))
      AND c.workspace_id = p_workspace_id AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.channel_id = c.id)
      AND (NOT c.is_private OR user_is_channel_member(c.id, p_actor))
      AND (lower(c.name) LIKE v_like OR lower(coalesce(c.description, '')) LIKE v_like)
    UNION ALL
    -- People in the workspace
    SELECT 'person', pr.id, coalesce(pr.display_name, pr.username, pr.email)::text, coalesce('@' || pr.username, '')::text,
      '/profile?user=' || pr.id, 'Member', pr.created_at, 1.0::real, NULL::uuid, NULL::uuid
    FROM workspace_members wm JOIN profiles pr ON pr.id = wm.user_id
    WHERE (p_types IS NULL OR 'person' = ANY(p_types))
      AND wm.workspace_id = p_workspace_id
      AND (lower(coalesce(pr.display_name, '')) LIKE v_like OR lower(coalesce(pr.username, '')) LIKE v_like)
    UNION ALL
    -- Drive items by name
    SELECT 'file', i.id, i.name, coalesce(i.mime_type, i.kind)::text, '/drive/item/' || i.id,
      CASE i.kind WHEN 'folder' THEN 'Folder' WHEN 'document' THEN 'Document' ELSE 'File' END, i.updated_at, 1.0::real,
      NULL::uuid, i.id
    FROM drive_items i
    WHERE (p_types IS NULL OR 'file' = ANY(p_types))
      AND i.workspace_id = p_workspace_id AND i.trashed_at IS NULL
      AND (i.kind <> 'file' OR i.current_version_id IS NOT NULL)
      AND lower(i.name) LIKE v_like
      AND drive_viewable_by(i.id, p_actor)
    UNION ALL
    -- Document and file text (current, indexed, accessible)
    SELECT 'file_text', k.item_id, max(i.name), left(max(k.content), 300)::text, '/drive/item/' || k.item_id,
      'In file', max(i.updated_at), max(ts_rank(k.tsv, v_tsq)), NULL::uuid, k.item_id
    FROM knowledge_chunks k
    JOIN knowledge_sources s ON s.id = k.source_id AND s.status = 'ready' AND s.superseded_at IS NULL
    JOIN drive_items i ON i.id = k.item_id
    WHERE (p_types IS NULL OR 'file' = ANY(p_types))
      AND k.workspace_id = p_workspace_id AND v_tsq IS NOT NULL AND k.tsv @@ v_tsq
      AND drive_viewable_by(k.item_id, p_actor)
    GROUP BY k.item_id
    UNION ALL
    -- Tasks the actor can see
    SELECT 'task', t.id, t.title, left(coalesce(t.description, ''), 300)::text, '/tasks/' || t.id,
      coalesce((SELECT 'Project: ' || p.name FROM projects p WHERE p.id = t.project_id), 'Task'), t.updated_at, 1.0::real,
      NULL::uuid, NULL::uuid
    FROM tasks t
    WHERE (p_types IS NULL OR 'task' = ANY(p_types))
      AND t.workspace_id = p_workspace_id AND t.deleted_at IS NULL
      AND (lower(t.title) LIKE v_like OR lower(coalesce(t.description, '')) LIKE v_like)
      AND task_visible_to(t.id, p_actor)
    UNION ALL
    -- Agents
    SELECT 'agent', a.id, a.name, a.description, '/agents/' || a.id, 'Agent', a.created_at, 1.0::real, NULL::uuid, NULL::uuid
    FROM workspace_agents a
    WHERE (p_types IS NULL OR 'agent' = ANY(p_types))
      AND a.workspace_id = p_workspace_id AND agent_visible_to(a.id, p_actor)
      AND (lower(a.name) LIKE v_like OR lower(a.description) LIKE v_like OR lower(a.handle) LIKE v_like)
  ) results
  ORDER BY 8 DESC, 7 DESC
  LIMIT least(greatest(p_limit, 1), 50);
END $$;

CREATE OR REPLACE FUNCTION public.search_workspace(p_workspace_id uuid, p_query text, p_types text[] DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS TABLE(result_type text, id uuid, title text, snippet text, link text, context text, created_at timestamptz, rank real,
  channel_id uuid, item_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT * FROM search_workspace_for(auth.uid(), p_workspace_id, p_query, p_types, p_limit);
$$;

-- Bounded read of a channel or thread for one actor.
CREATE OR REPLACE FUNCTION public.agent_read_conversation_for(
  p_actor uuid, p_channel_id uuid, p_root_id uuid DEFAULT NULL, p_limit integer DEFAULT 60, p_before timestamptz DEFAULT NULL
) RETURNS TABLE(id uuid, author_id uuid, author_name text, is_agent boolean, content text, created_at timestamptz,
  parent_id uuid, reply_count bigint, channel_name text, is_direct boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT user_is_channel_member(p_channel_id, p_actor) THEN RETURN; END IF;
  RETURN QUERY
  SELECT * FROM (
    SELECT m.id, m.user_id,
      coalesce(a.name || ' (agent, via ' || coalesce(pr.display_name, pr.username, 'a member') || ')',
               pr.display_name, pr.username, 'Someone')::text,
      m.agent_id IS NOT NULL, m.content, m.created_at, m.parent_id,
      (SELECT count(*) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL),
      c.name::text, EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.channel_id = c.id)
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN profiles pr ON pr.id = m.user_id
    LEFT JOIN workspace_agents a ON a.id = m.agent_id
    WHERE m.channel_id = p_channel_id AND m.deleted_at IS NULL
      AND (CASE WHEN p_root_id IS NULL THEN m.parent_id IS NULL ELSE (m.id = p_root_id OR m.parent_id = p_root_id) END)
      AND (p_before IS NULL OR m.created_at < p_before)
    ORDER BY m.created_at DESC
    LIMIT least(greatest(p_limit, 1), 200)
  ) recent ORDER BY 6;
END $$;

CREATE OR REPLACE FUNCTION public.agent_list_tasks_for(
  p_actor uuid, p_workspace_id uuid, p_project_id uuid DEFAULT NULL, p_mine boolean DEFAULT false,
  p_include_completed boolean DEFAULT false, p_limit integer DEFAULT 50
) RETURNS TABLE(id uuid, title text, status text, priority text, due_date timestamptz, project_id uuid, project_name text,
  assignees text[], created_by_name text, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT user_is_workspace_member(p_workspace_id, p_actor) THEN RETURN; END IF;
  RETURN QUERY
  SELECT t.id, t.title, t.status, t.priority, t.due_date, t.project_id, p.name,
    coalesce(ARRAY(SELECT coalesce(pr.display_name, pr.username) FROM task_assignees ta JOIN profiles pr ON pr.id = ta.user_id
                   WHERE ta.task_id = t.id), '{}'),
    (SELECT coalesce(pr.display_name, pr.username) FROM profiles pr WHERE pr.id = t.created_by),
    t.updated_at
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
  WHERE t.workspace_id = p_workspace_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
    AND (p_project_id IS NULL OR t.project_id = p_project_id)
    AND (NOT p_mine OR t.created_by = p_actor OR is_task_assignee(t.id, p_actor))
    AND (p_include_completed OR t.status NOT IN ('completed', 'cancelled'))
    AND task_visible_to(t.id, p_actor)
  ORDER BY t.due_date NULLS LAST, t.updated_at DESC
  LIMIT least(greatest(p_limit, 1), 200);
END $$;

-- Resolve people the model referred to by name, among workspace members.
CREATE OR REPLACE FUNCTION public.agent_resolve_members_for(p_actor uuid, p_workspace_id uuid, p_names text[])
RETURNS TABLE(query text, user_id uuid, display_name text, username text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT user_is_workspace_member(p_workspace_id, p_actor) THEN RETURN; END IF;
  RETURN QUERY
  SELECT n, pr.id, pr.display_name, pr.username
  FROM unnest(p_names) n
  JOIN workspace_members wm ON wm.workspace_id = p_workspace_id
  JOIN profiles pr ON pr.id = wm.user_id
  WHERE lower(btrim(n, ' @')) IN (lower(coalesce(pr.username, '')), lower(coalesce(pr.display_name, '')), lower(coalesce(pr.email, '')))
     OR (length(btrim(n)) >= 3 AND lower(coalesce(pr.display_name, '')) LIKE lower(btrim(n, ' @')) || '%');
END $$;

-- Storage location of the current version of a file the actor can open
-- (used by the CSV metrics tool, which needs the raw file).
CREATE OR REPLACE FUNCTION public.agent_file_for(p_actor uuid, p_item_id uuid)
RETURNS TABLE(item_id uuid, name text, version_id uuid, bucket text, path text, mime_type text, size_bytes bigint, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT i.id, i.name, v.id, v.storage_bucket, v.storage_path, v.mime_type, v.size_bytes, i.workspace_id
  FROM drive_items i JOIN drive_versions v ON v.id = i.current_version_id
  WHERE i.id = p_item_id AND i.kind = 'file' AND v.status = 'ready' AND drive_viewable_by(i.id, p_actor);
$$;

-- Channels a run may reference by name (only ones the actor belongs to).
CREATE OR REPLACE FUNCTION public.agent_channels_for(p_actor uuid, p_workspace_id uuid)
RETURNS TABLE(id uuid, name text, is_private boolean, is_direct boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT c.id, c.name, c.is_private, EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.channel_id = c.id)
  FROM channels c
  WHERE c.workspace_id = p_workspace_id AND c.archived_at IS NULL AND user_is_channel_member(c.id, p_actor)
  ORDER BY c.name;
$$;

-- Projects the actor can read (names are resolved only among these).
CREATE OR REPLACE FUNCTION public.agent_projects_for(p_actor uuid, p_workspace_id uuid)
RETURNS TABLE(id uuid, name text, status text, can_edit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p.id, p.name, p.status, is_project_editor(p.id, p_actor)
  FROM projects p
  WHERE p.workspace_id = p_workspace_id AND p.deleted_at IS NULL AND p.archived_at IS NULL
    AND user_is_workspace_member(p_workspace_id, p_actor) AND is_project_readable(p.id, p_actor)
  ORDER BY p.name;
$$;

-- Name, type and index state of items the actor can open (selected sources,
-- read_file status messages). Items the actor cannot open are omitted.
CREATE OR REPLACE FUNCTION public.agent_scope_items_for(p_actor uuid, p_item_ids uuid[])
RETURNS TABLE(id uuid, name text, kind text, mime_type text, workspace_id uuid, index_status text, index_message text,
  truncated boolean, chunk_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT i.id, i.name, i.kind, i.mime_type, i.workspace_id, s.status, s.error_message, coalesce(s.truncated, false), s.chunk_count
  FROM drive_items i
  LEFT JOIN LATERAL (
    SELECT ks.status, ks.error_message, ks.truncated, ks.chunk_count FROM knowledge_sources ks
    WHERE ks.item_id = i.id AND ks.superseded_at IS NULL ORDER BY ks.created_at DESC LIMIT 1
  ) s ON true
  WHERE i.id = ANY(p_item_ids) AND drive_viewable_by(i.id, p_actor);
$$;

-- Sources a run used that some audience member could not open themselves
-- (files, conversations and tasks).
CREATE OR REPLACE FUNCTION public.agent_audience_gaps(p_run_id uuid, p_audience uuid[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'ref_id', s.ref_id, 'label', s.label)), '[]'::jsonb)
  FROM agent_run_sources s
  WHERE s.run_id = p_run_id AND (
    (s.kind = 'drive_item' AND EXISTS (SELECT 1 FROM unnest(p_audience) u WHERE NOT drive_viewable_by(s.item_id, u)))
    OR (s.kind = 'channel' AND EXISTS (SELECT 1 FROM unnest(p_audience) u WHERE NOT user_is_channel_member(s.channel_id, u)))
    OR (s.kind = 'task' AND EXISTS (SELECT 1 FROM unnest(p_audience) u WHERE NOT task_visible_to(s.ref_id::uuid, u)))
  );
$$;

-- Share a finished private answer to a conversation: creates a review card
-- (post_message proposal) after the same audience check as agent proposals.
CREATE OR REPLACE FUNCTION public.agent_share_output(p_run_id uuid, p_channel_id uuid, p_parent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_run agent_runs%ROWTYPE; v_content text; v_args jsonb; v_gaps jsonb; v_id uuid;
BEGIN
  SELECT * INTO v_run FROM agent_runs WHERE id = p_run_id AND requested_by = auth.uid();
  IF v_run.id IS NULL OR v_run.status NOT IN ('completed', 'awaiting_approval') THEN
    RAISE EXCEPTION 'Answer not found' USING ERRCODE = '42501';
  END IF;
  IF NOT user_is_channel_member(p_channel_id, auth.uid()) OR channel_workspace_id(p_channel_id) <> v_run.workspace_id THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;
  SELECT content INTO v_content FROM agent_messages WHERE id = v_run.output_message_id;
  v_args := jsonb_build_object('channel_id', p_channel_id, 'parent_id', p_parent_id, 'content', v_content);
  v_gaps := agent_audience_gaps(p_run_id, agent_action_audience(v_run.workspace_id, auth.uid(), 'post_message', v_args));
  IF jsonb_array_length(v_gaps) > 0 THEN
    RETURN jsonb_build_object('status', 'blocked_audience', 'sources', v_gaps);
  END IF;
  INSERT INTO agent_action_proposals (workspace_id, run_id, conversation_id, action_type, arguments, arguments_hash, summary,
                                      destination, requested_for, idempotency_key)
  VALUES (v_run.workspace_id, p_run_id, v_run.conversation_id, 'post_message', v_args, agent_hash_arguments(v_args),
          'Share this answer in the conversation',
          jsonb_build_object('type', 'channel', 'channel_id', p_channel_id, 'parent_id', p_parent_id),
          auth.uid(), 'share:' || p_run_id || ':' || p_channel_id || ':' || coalesce(p_parent_id::text, '') || ':' || gen_random_uuid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('status', 'proposed', 'proposal_id', v_id, 'arguments_hash', agent_hash_arguments(v_args));
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.task_visible_to(uuid, uuid)',
    'public.search_workspace_for(uuid, uuid, text, text[], integer)',
    'public.agent_read_conversation_for(uuid, uuid, uuid, integer, timestamptz)',
    'public.agent_list_tasks_for(uuid, uuid, uuid, boolean, boolean, integer)',
    'public.agent_resolve_members_for(uuid, uuid, text[])',
    'public.agent_file_for(uuid, uuid)',
    'public.agent_channels_for(uuid, uuid)',
    'public.agent_projects_for(uuid, uuid)',
    'public.agent_scope_items_for(uuid, uuid[])',
    'public.agent_audience_gaps(uuid, uuid[])'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.search_workspace(uuid, text, text[], integer)', 'public.agent_share_output(uuid, uuid, uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
