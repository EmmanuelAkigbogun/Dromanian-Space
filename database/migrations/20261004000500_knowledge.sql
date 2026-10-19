-- ============================================================================
-- 20261004000500_knowledge.sql
-- ----------------------------------------------------------------------------
-- Knowledge pipeline for Drive content:
--   version uploaded / revision saved -> knowledge source queued (+ job)
--   -> worker extracts text -> bounded chunks with stable locations
--   -> optional embeddings (configured model; dimension recorded)
--   -> retrieval filtered INSIDE SQL by workspace membership and current Drive
--      access of the acting user, then ranked (full-text, optionally fused
--      with vector similarity).
-- Superseded versions, trash, revoked grants and membership removal take
-- effect at query time; nothing is filtered after the fact in application code.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  item_id uuid NOT NULL,
  version_id uuid,
  revision_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'extracting', 'indexing', 'ready', 'failed', 'unsupported', 'too_large', 'no_text', 'encrypted', 'superseded')),
  mime_type text,
  extractor text,
  char_count integer,
  page_count integer,
  row_count integer,
  chunk_count integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  error_code text,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 1000),
  embedding_status text NOT NULL DEFAULT 'not_configured'
    CHECK (embedding_status IN ('not_configured', 'pending', 'ready', 'failed')),
  embedding_model text,
  embedding_dimensions integer,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz,
  superseded_at timestamptz,
  CHECK ((version_id IS NOT NULL) <> (revision_id IS NOT NULL)),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, workspace_id) REFERENCES drive_versions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id, workspace_id) REFERENCES drive_document_revisions(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_sources_version ON knowledge_sources (version_id) WHERE version_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_sources_revision ON knowledge_sources (revision_id) WHERE revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_item ON knowledge_sources (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_ready ON knowledge_sources (workspace_id) WHERE status = 'ready' AND superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  item_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  -- {page, page_end, section, start_char, end_char, row_start, row_end}
  location jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_estimate integer NOT NULL DEFAULT 0,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (source_id, chunk_index),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (source_id, workspace_id) REFERENCES knowledge_sources(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tsv ON knowledge_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks (source_id, chunk_index);

CREATE TABLE IF NOT EXISTS public.knowledge_embeddings (
  chunk_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 64 AND 4096),
  embedding extensions.vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (chunk_id, workspace_id) REFERENCES knowledge_chunks(id, workspace_id) ON DELETE CASCADE,
  CHECK (extensions.vector_dims(embedding) = dimensions)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_model ON knowledge_embeddings (workspace_id, model);

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_embeddings ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON knowledge_sources, knowledge_chunks FROM anon, authenticated;
REVOKE ALL ON knowledge_embeddings FROM anon, authenticated;

DROP POLICY IF EXISTS "knowledge_sources_select" ON knowledge_sources;
CREATE POLICY "knowledge_sources_select" ON knowledge_sources FOR SELECT TO authenticated
  USING (public.drive_can_view(item_id, auth.uid()));

-- Chunk text is readable only for the current, ready source of an item the
-- caller can open (citations and search snippets).
DROP POLICY IF EXISTS "knowledge_chunks_select" ON knowledge_chunks;
CREATE POLICY "knowledge_chunks_select" ON knowledge_chunks FOR SELECT TO authenticated
  USING (
    public.drive_can_view(item_id, auth.uid())
    AND EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.id = source_id AND s.status = 'ready' AND s.superseded_at IS NULL)
  );

-- Types the extractor understands (text-based PDF, DOCX, TXT, Markdown, CSV).
CREATE OR REPLACE FUNCTION public.knowledge_supported_type(p_mime text, p_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(coalesce(p_mime, '')) IN (
      'application/pdf', 'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'application/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    OR lower(coalesce(p_name, '')) ~ '\.(pdf|txt|md|markdown|csv|docx)$';
$$;

-- Replaces the Drive stub. Supersedes older sources of the item (they stop
-- being retrievable immediately) and queues extraction.
CREATE OR REPLACE FUNCTION public.knowledge_enqueue_source(p_item_id uuid, p_version_id uuid, p_revision_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_item drive_items%ROWTYPE;
  v_version drive_versions%ROWTYPE;
  v_source uuid;
  v_job uuid;
  v_supported boolean;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR v_item.kind = 'folder' THEN RETURN; END IF;

  IF p_revision_id IS NOT NULL THEN
    -- Documents: keep one queued source per item and point it at the newest
    -- revision, so rapid autosaves do not queue a job per keystroke.
    SELECT id INTO v_source FROM knowledge_sources
    WHERE item_id = p_item_id AND revision_id IS NOT NULL AND status = 'queued' AND superseded_at IS NULL
    ORDER BY created_at DESC LIMIT 1;
    IF v_source IS NOT NULL THEN
      UPDATE knowledge_sources SET revision_id = p_revision_id, updated_at = now() WHERE id = v_source;
      UPDATE jobs SET run_after = now() + interval '20 seconds', updated_at = now()
      WHERE kind = 'knowledge.extract' AND idempotency_key = 'ks:' || v_source AND status = 'queued';
      RETURN;
    END IF;
    v_supported := true;
  ELSE
    SELECT * INTO v_version FROM drive_versions WHERE id = p_version_id;
    v_supported := knowledge_supported_type(v_version.mime_type, v_version.original_name);
  END IF;

  UPDATE knowledge_sources SET status = CASE WHEN status IN ('ready', 'queued', 'extracting', 'indexing') THEN 'superseded' ELSE status END,
    superseded_at = now(), updated_at = now()
  WHERE item_id = p_item_id AND superseded_at IS NULL;

  INSERT INTO knowledge_sources (workspace_id, item_id, version_id, revision_id, status, mime_type, error_code, error_message)
  VALUES (v_item.workspace_id, p_item_id, p_version_id, p_revision_id,
          CASE WHEN v_supported THEN 'queued' ELSE 'unsupported' END,
          coalesce(v_version.mime_type, 'text/markdown'),
          CASE WHEN v_supported THEN NULL ELSE 'unsupported_type' END,
          CASE WHEN v_supported THEN NULL ELSE 'This file type is not indexed. Supported: PDF with a text layer, DOCX, TXT, Markdown and CSV.' END)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_source;

  IF v_source IS NOT NULL AND v_supported THEN
    v_job := enqueue_job('knowledge.extract', v_item.workspace_id, NULL, jsonb_build_object('source_id', v_source),
      'ks:' || v_source, now() + CASE WHEN p_revision_id IS NOT NULL THEN interval '20 seconds' ELSE interval '0' END, 4);
    UPDATE knowledge_sources SET job_id = v_job WHERE id = v_source;
  END IF;
END $$;

-- Worker: fetch what to extract. Returns NULL if the source is no longer current.
CREATE OR REPLACE FUNCTION public.knowledge_begin_extraction(p_source_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_source knowledge_sources%ROWTYPE; v_item drive_items%ROWTYPE; v_version drive_versions%ROWTYPE; v_rev drive_document_revisions%ROWTYPE;
BEGIN
  SELECT * INTO v_source FROM knowledge_sources WHERE id = p_source_id FOR UPDATE;
  IF v_source.id IS NULL OR v_source.superseded_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_item FROM drive_items WHERE id = v_source.item_id;
  IF v_item.id IS NULL OR v_item.purge_requested_at IS NOT NULL THEN RETURN NULL; END IF;
  UPDATE knowledge_sources SET status = 'extracting', updated_at = now(), error_code = NULL, error_message = NULL WHERE id = p_source_id;
  IF v_source.version_id IS NOT NULL THEN
    SELECT * INTO v_version FROM drive_versions WHERE id = v_source.version_id;
    RETURN jsonb_build_object('source_id', p_source_id, 'workspace_id', v_source.workspace_id, 'item_id', v_item.id,
      'kind', 'file', 'bucket', v_version.storage_bucket, 'path', v_version.storage_path, 'mime_type', v_version.mime_type,
      'name', v_version.original_name, 'size_bytes', v_version.size_bytes);
  END IF;
  SELECT * INTO v_rev FROM drive_document_revisions WHERE id = v_source.revision_id;
  RETURN jsonb_build_object('source_id', p_source_id, 'workspace_id', v_source.workspace_id, 'item_id', v_item.id,
    'kind', 'document', 'title', v_rev.title, 'body', v_rev.body, 'revision_no', v_rev.revision_no);
END $$;

-- Worker: store chunks atomically (replaces any previous attempt).
CREATE OR REPLACE FUNCTION public.knowledge_store_chunks(p_source_id uuid, p_chunks jsonb, p_meta jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_source knowledge_sources%ROWTYPE; v_count integer;
BEGIN
  SELECT * INTO v_source FROM knowledge_sources WHERE id = p_source_id FOR UPDATE;
  IF v_source.id IS NULL OR v_source.superseded_at IS NOT NULL THEN RETURN 'superseded'; END IF;
  DELETE FROM knowledge_chunks WHERE source_id = p_source_id;
  INSERT INTO knowledge_chunks (workspace_id, source_id, item_id, chunk_index, content, location, token_estimate)
  SELECT v_source.workspace_id, p_source_id, v_source.item_id, (c ->> 'index')::integer, c ->> 'content',
         coalesce(c -> 'location', '{}'::jsonb), coalesce((c ->> 'tokens')::integer, 0)
  FROM jsonb_array_elements(p_chunks) c;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE knowledge_sources SET
    status = CASE WHEN v_count = 0 THEN 'no_text' ELSE coalesce(p_meta ->> 'status', 'ready') END,
    chunk_count = v_count,
    char_count = (p_meta ->> 'char_count')::integer,
    page_count = (p_meta ->> 'page_count')::integer,
    row_count = (p_meta ->> 'row_count')::integer,
    truncated = coalesce((p_meta ->> 'truncated')::boolean, false),
    extractor = p_meta ->> 'extractor',
    embedding_status = coalesce(p_meta ->> 'embedding_status', 'not_configured'),
    error_code = CASE WHEN v_count = 0 THEN 'no_text' END,
    error_message = CASE WHEN v_count = 0 THEN coalesce(p_meta ->> 'no_text_reason',
      'No extractable text was found. Scanned documents need OCR, which is not supported yet.') END,
    indexed_at = CASE WHEN v_count > 0 THEN now() END,
    updated_at = now()
  WHERE id = p_source_id;
  RETURN CASE WHEN v_count = 0 THEN 'no_text' ELSE 'stored' END;
END $$;

CREATE OR REPLACE FUNCTION public.knowledge_store_embeddings(p_source_id uuid, p_model text, p_dimensions integer, p_items jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_source knowledge_sources%ROWTYPE; v_count integer;
BEGIN
  SELECT * INTO v_source FROM knowledge_sources WHERE id = p_source_id FOR UPDATE;
  IF v_source.id IS NULL OR v_source.superseded_at IS NOT NULL THEN RETURN 0; END IF;
  INSERT INTO knowledge_embeddings (chunk_id, workspace_id, model, dimensions, embedding)
  SELECT (e ->> 'chunk_id')::uuid, v_source.workspace_id, p_model, p_dimensions, (e ->> 'embedding')::extensions.vector
  FROM jsonb_array_elements(p_items) e
  JOIN knowledge_chunks c ON c.id = (e ->> 'chunk_id')::uuid AND c.source_id = p_source_id
  ON CONFLICT (chunk_id) DO UPDATE SET model = EXCLUDED.model, dimensions = EXCLUDED.dimensions, embedding = EXCLUDED.embedding, created_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE knowledge_sources SET embedding_status = 'ready', embedding_model = p_model, embedding_dimensions = p_dimensions,
    status = CASE WHEN status = 'indexing' THEN 'ready' ELSE status END, updated_at = now()
  WHERE id = p_source_id;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.knowledge_mark_failed(p_source_id uuid, p_status text, p_error_code text, p_message text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE knowledge_sources SET
    status = CASE WHEN p_status IN ('failed', 'unsupported', 'too_large', 'no_text', 'encrypted') THEN p_status ELSE 'failed' END,
    error_code = left(p_error_code, 60), error_message = left(p_message, 1000), updated_at = now()
  WHERE id = p_source_id AND superseded_at IS NULL;
$$;

-- Manual re-index of an item the caller can edit (e.g. after a failure).
CREATE OR REPLACE FUNCTION public.knowledge_reindex_item(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_rev uuid;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR NOT drive_can_edit(p_item_id, auth.uid()) THEN
    RAISE EXCEPTION 'You need edit access to re-index this item' USING ERRCODE = '42501';
  END IF;
  -- Force a fresh source even if one already exists for the current version.
  UPDATE knowledge_sources SET status = 'superseded', superseded_at = now() WHERE item_id = p_item_id AND superseded_at IS NULL;
  IF v_item.kind = 'document' THEN
    SELECT id INTO v_rev FROM drive_document_revisions WHERE item_id = p_item_id ORDER BY revision_no DESC LIMIT 1;
    DELETE FROM knowledge_sources WHERE revision_id = v_rev;
    PERFORM knowledge_enqueue_source(p_item_id, NULL, v_rev);
  ELSE
    DELETE FROM knowledge_sources WHERE version_id = v_item.current_version_id;
    PERFORM knowledge_enqueue_source(p_item_id, v_item.current_version_id, NULL);
  END IF;
END $$;

-- Current index status per item (UI badges). Self-only through RLS on sources.
CREATE OR REPLACE FUNCTION public.knowledge_item_status(p_item_ids uuid[])
RETURNS TABLE(item_id uuid, source_id uuid, status text, chunk_count integer, truncated boolean, embedding_status text,
  error_code text, error_message text, indexed_at timestamptz, version_id uuid, revision_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $$
  SELECT DISTINCT ON (s.item_id) s.item_id, s.id, s.status, s.chunk_count, s.truncated, s.embedding_status,
    s.error_code, s.error_message, s.indexed_at, s.version_id, s.revision_id
  FROM knowledge_sources s
  WHERE s.item_id = ANY(p_item_ids) AND s.superseded_at IS NULL
  ORDER BY s.item_id, s.created_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- Retrieval. Authorization happens here, before any chunk leaves the
-- database: the allowed item set is computed for the acting user first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.knowledge_search_for(
  p_actor uuid, p_workspace_id uuid, p_query text, p_item_ids uuid[] DEFAULT NULL, p_limit integer DEFAULT 8,
  p_query_embedding extensions.vector DEFAULT NULL, p_embedding_model text DEFAULT NULL
) RETURNS TABLE(chunk_id uuid, item_id uuid, source_id uuid, version_id uuid, revision_id uuid, item_name text,
  chunk_index integer, content text, location jsonb, score double precision, match text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_tsq tsquery;
BEGIN
  IF p_actor IS NULL OR NOT user_is_workspace_member(p_workspace_id, p_actor) THEN RETURN; END IF;
  -- Questions are matched on any of their stemmed terms; ts_rank_cd rewards
  -- passages that contain more of them (AND semantics would miss most questions).
  SELECT to_tsquery('simple', string_agg(quote_literal(lex), ' | '))
  INTO v_tsq
  FROM unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) AS lex;
  v_tsq := coalesce(v_tsq, ''::tsquery);
  RETURN QUERY
  WITH allowed AS (
    SELECT s.id AS source_id, s.item_id, s.version_id, s.revision_id
    FROM knowledge_sources s
    WHERE s.workspace_id = p_workspace_id AND s.status = 'ready' AND s.superseded_at IS NULL
      AND (p_item_ids IS NULL OR s.item_id = ANY(p_item_ids))
      AND drive_viewable_by(s.item_id, p_actor)
  ), fts AS (
    SELECT c.id, ts_rank_cd(c.tsv, v_tsq) AS rank,
           row_number() OVER (ORDER BY ts_rank_cd(c.tsv, v_tsq) DESC, c.chunk_index) AS rn
    FROM knowledge_chunks c JOIN allowed a ON a.source_id = c.source_id
    WHERE numnode(v_tsq) > 0 AND c.tsv @@ v_tsq
    ORDER BY rank DESC LIMIT 60
  ), vec AS (
    SELECT c.id, 1 - (e.embedding <=> p_query_embedding) AS sim,
           row_number() OVER (ORDER BY e.embedding <=> p_query_embedding) AS rn
    FROM knowledge_chunks c JOIN allowed a ON a.source_id = c.source_id
    JOIN knowledge_embeddings e ON e.chunk_id = c.id AND e.model = p_embedding_model
      AND e.dimensions = vector_dims(p_query_embedding)
    WHERE p_query_embedding IS NOT NULL
    ORDER BY e.embedding <=> p_query_embedding LIMIT 60
  ), fused AS (
    SELECT coalesce(f.id, v.id) AS id,
           coalesce(1.0 / (60 + f.rn), 0) + coalesce(1.0 / (60 + v.rn), 0) AS score,
           CASE WHEN f.id IS NOT NULL AND v.id IS NOT NULL THEN 'hybrid' WHEN f.id IS NOT NULL THEN 'keyword' ELSE 'semantic' END AS match
    FROM fts f FULL OUTER JOIN vec v ON v.id = f.id
  )
  SELECT c.id, c.item_id, c.source_id, a.version_id, a.revision_id, i.name, c.chunk_index, c.content, c.location,
         fu.score::double precision, fu.match
  FROM fused fu
  JOIN knowledge_chunks c ON c.id = fu.id
  JOIN allowed a ON a.source_id = c.source_id
  JOIN drive_items i ON i.id = c.item_id
  ORDER BY fu.score DESC, c.chunk_index
  LIMIT least(greatest(p_limit, 1), 40);
END $$;

-- Reads a bounded window of an item's current text (the "read file" tool).
CREATE OR REPLACE FUNCTION public.knowledge_read_item_for(p_actor uuid, p_item_id uuid, p_from_chunk integer DEFAULT 0, p_max_chunks integer DEFAULT 12)
RETURNS TABLE(chunk_id uuid, source_id uuid, version_id uuid, revision_id uuid, item_name text, chunk_index integer,
  content text, location jsonb, total_chunks integer, source_status text, truncated boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT drive_viewable_by(p_item_id, p_actor) THEN RETURN; END IF;
  RETURN QUERY
  SELECT c.id, s.id, s.version_id, s.revision_id, i.name, c.chunk_index, c.content, c.location, s.chunk_count, s.status, s.truncated
  FROM knowledge_sources s
  JOIN drive_items i ON i.id = s.item_id
  JOIN knowledge_chunks c ON c.source_id = s.id
  WHERE s.item_id = p_item_id AND s.status = 'ready' AND s.superseded_at IS NULL
    AND c.chunk_index >= greatest(p_from_chunk, 0)
  ORDER BY c.chunk_index
  LIMIT least(greatest(p_max_chunks, 1), 40);
END $$;

-- Client-callable wrappers: the actor is always the signed-in user.
CREATE OR REPLACE FUNCTION public.knowledge_search(p_workspace_id uuid, p_query text, p_item_ids uuid[] DEFAULT NULL, p_limit integer DEFAULT 8)
RETURNS TABLE(chunk_id uuid, item_id uuid, source_id uuid, version_id uuid, revision_id uuid, item_name text,
  chunk_index integer, content text, location jsonb, score double precision, match text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT * FROM knowledge_search_for(auth.uid(), p_workspace_id, p_query, p_item_ids, p_limit, NULL, NULL);
$$;

CREATE OR REPLACE FUNCTION public.knowledge_read_item(p_item_id uuid, p_from_chunk integer DEFAULT 0, p_max_chunks integer DEFAULT 12)
RETURNS TABLE(chunk_id uuid, source_id uuid, version_id uuid, revision_id uuid, item_name text, chunk_index integer,
  content text, location jsonb, total_chunks integer, source_status text, truncated boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT * FROM knowledge_read_item_for(auth.uid(), p_item_id, p_from_chunk, p_max_chunks);
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.knowledge_enqueue_source(uuid, uuid, uuid)',
    'public.knowledge_begin_extraction(uuid)',
    'public.knowledge_store_chunks(uuid, jsonb, jsonb)',
    'public.knowledge_store_embeddings(uuid, text, integer, jsonb)',
    'public.knowledge_mark_failed(uuid, text, text, text)',
    'public.knowledge_search_for(uuid, uuid, text, uuid[], integer, extensions.vector, text)',
    'public.knowledge_read_item_for(uuid, uuid, integer, integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.knowledge_reindex_item(uuid)',
    'public.knowledge_item_status(uuid[])',
    'public.knowledge_search(uuid, text, uuid[], integer)',
    'public.knowledge_read_item(uuid, integer, integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

-- Queue sources for content that already exists in Drive (rerunnable).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT i.id, i.kind, i.current_version_id,
      (SELECT d.id FROM drive_document_revisions d WHERE d.item_id = i.id ORDER BY d.revision_no DESC LIMIT 1) AS rev
    FROM drive_items i
    WHERE i.kind <> 'folder' AND i.trashed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.item_id = i.id)
  LOOP
    IF r.kind = 'document' AND r.rev IS NOT NULL THEN
      PERFORM knowledge_enqueue_source(r.id, NULL, r.rev);
    ELSIF r.current_version_id IS NOT NULL THEN
      PERFORM knowledge_enqueue_source(r.id, r.current_version_id, NULL);
    END IF;
  END LOOP;
END $$;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
