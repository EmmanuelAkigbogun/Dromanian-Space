-- ============================================================================
-- 20261004000450_drive_legacy_backfill.sql
-- ----------------------------------------------------------------------------
-- Links every existing file_attachments row to a Drive item, preserving the
-- audience that could already see it (a viewer grant to the conversation the
-- message was posted in - channel, private channel, DM or group DM). Nothing is
-- made workspace-visible and nothing is deleted.
--
--   * One logical item per (workspace, storage object); forwarded copies share
--     it and add their own conversation grant.
--   * External link attachments are recorded as 'link_attachment' (not files).
--   * Rows whose object is missing or that hold a browser-local URL are
--     recorded for review ('missing_object', 'local_url'), not guessed.
--   * Rerunnable: rows already linked are skipped. Progress is recorded in
--     drive_backfill_runs. Run more batches with:
--       SELECT public.drive_backfill_legacy_attachments(5000);
--     Report: SELECT * FROM public.drive_backfill_report();
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.drive_backfill_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  batch_size integer NOT NULL,
  processed integer NOT NULL DEFAULT 0,
  linked integer NOT NULL DEFAULT 0,
  link_attachments integer NOT NULL DEFAULT 0,
  missing_objects integer NOT NULL DEFAULT 0,
  local_urls integer NOT NULL DEFAULT 0,
  other integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  last_error text
);
ALTER TABLE drive_backfill_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_backfill_runs FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.drive_backfill_legacy_attachments(p_batch_size integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run bigint;
  r record;
  v_status text;
  v_counts jsonb := '{}'::jsonb;
  v_processed integer := 0;
  v_errors integer := 0;
  v_last_error text;
  v_remaining bigint;
BEGIN
  INSERT INTO drive_backfill_runs (batch_size) VALUES (p_batch_size) RETURNING id INTO v_run;
  FOR r IN
    SELECT fa.id FROM file_attachments fa
    WHERE NOT EXISTS (SELECT 1 FROM file_attachment_drive_links l WHERE l.attachment_id = fa.id)
    ORDER BY fa.created_at, fa.id
    LIMIT greatest(1, p_batch_size)
  LOOP
    BEGIN
      v_status := drive_link_attachment(r.id, 'legacy_backfill');
      v_counts := jsonb_set(v_counts, ARRAY[v_status], to_jsonb(coalesce((v_counts ->> v_status)::integer, 0) + 1));
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      v_last_error := left(SQLERRM, 500);
    END;
    v_processed := v_processed + 1;
  END LOOP;
  SELECT count(*) INTO v_remaining FROM file_attachments fa
  WHERE NOT EXISTS (SELECT 1 FROM file_attachment_drive_links l WHERE l.attachment_id = fa.id);
  UPDATE drive_backfill_runs SET finished_at = now(), processed = v_processed,
    linked = coalesce((v_counts ->> 'linked')::integer, 0),
    link_attachments = coalesce((v_counts ->> 'link_attachment')::integer, 0),
    missing_objects = coalesce((v_counts ->> 'missing_object')::integer, 0),
    local_urls = coalesce((v_counts ->> 'local_url')::integer, 0),
    other = coalesce((v_counts ->> 'no_workspace')::integer, 0),
    errors = v_errors, last_error = v_last_error
  WHERE id = v_run;
  RETURN jsonb_build_object('run_id', v_run, 'processed', v_processed, 'by_status', v_counts,
                            'errors', v_errors, 'last_error', v_last_error, 'remaining', v_remaining);
END $$;

CREATE OR REPLACE FUNCTION public.drive_backfill_report()
RETURNS TABLE(status text, attachments bigint, sample_attachment_ids uuid[], note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT l.status, count(*), (array_agg(l.attachment_id ORDER BY l.linked_at))[1:20],
    CASE l.status
      WHEN 'linked' THEN 'Backed by a Drive item with the original conversation audience'
      WHEN 'link_attachment' THEN 'External link preview, not a stored file; unchanged'
      WHEN 'missing_object' THEN 'Storage object not found; attachment row left untouched for review'
      WHEN 'local_url' THEN 'Browser-local URL saved by an old client; cannot be recovered automatically'
      ELSE 'Message has no workspace; left untouched for review' END
  FROM file_attachment_drive_links l GROUP BY l.status
  UNION ALL
  SELECT 'unprocessed', count(*), (array_agg(fa.id ORDER BY fa.created_at))[1:20], 'Run drive_backfill_legacy_attachments() again'
  FROM file_attachments fa
  WHERE NOT EXISTS (SELECT 1 FROM file_attachment_drive_links l WHERE l.attachment_id = fa.id)
  HAVING count(*) > 0;
$$;

REVOKE EXECUTE ON FUNCTION public.drive_backfill_legacy_attachments(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.drive_backfill_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drive_backfill_legacy_attachments(integer), public.drive_backfill_report() TO service_role;

-- Run the backfill now in bounded batches (up to 50,000 rows in this
-- migration). Larger datasets: call the function again; it resumes.
DO $$
DECLARE v_result jsonb; i integer := 0;
BEGIN
  LOOP
    v_result := public.drive_backfill_legacy_attachments(5000);
    i := i + 1;
    EXIT WHEN (v_result ->> 'processed')::integer = 0 OR (v_result ->> 'remaining')::bigint = 0 OR i >= 10;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
