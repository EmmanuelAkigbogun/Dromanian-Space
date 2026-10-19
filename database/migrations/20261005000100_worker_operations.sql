-- ============================================================================
-- 20261005000100_worker_operations.sql
-- ----------------------------------------------------------------------------
-- Operations support for the self-hosted worker:
--   * One authoritative scheduler per task: database maintenance runs through
--     pg_cron when its job exists; otherwise the worker runs it. Never both.
--   * Worker heartbeats with job progress, and a readiness summary (queue lag,
--     stale workers, dead jobs) for health checks. No secrets are exposed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
  worker text PRIMARY KEY CHECK (length(worker) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  jobs_running integer NOT NULL DEFAULT 0,
  jobs_completed bigint NOT NULL DEFAULT 0,
  jobs_failed bigint NOT NULL DEFAULT 0,
  last_job_finished_at timestamptz
);
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON worker_heartbeats FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.worker_heartbeat(p_worker text, p_running integer, p_completed bigint, p_failed bigint,
  p_last_finished timestamptz)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO worker_heartbeats (worker, jobs_running, jobs_completed, jobs_failed, last_job_finished_at)
  VALUES (p_worker, p_running, p_completed, p_failed, p_last_finished)
  ON CONFLICT (worker) DO UPDATE SET last_seen_at = now(), jobs_running = EXCLUDED.jobs_running,
    jobs_completed = EXCLUDED.jobs_completed, jobs_failed = EXCLUDED.jobs_failed,
    last_job_finished_at = coalesce(EXCLUDED.last_job_finished_at, worker_heartbeats.last_job_finished_at);
  DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day';
$$;

CREATE OR REPLACE FUNCTION public.worker_stopped(p_worker text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  DELETE FROM worker_heartbeats WHERE worker = p_worker;
$$;

-- Maintenance tasks and the pg_cron job that is authoritative for each.
CREATE OR REPLACE FUNCTION public.maintenance_tasks()
RETURNS TABLE(task text, cron_job text, fn text)
LANGUAGE sql IMMUTABLE AS $$
  VALUES
    ('scheduled_messages', 'send-due-scheduled-messages', 'send_due_scheduled_messages'),
    ('expired_drafts', 'expire-stale-scheduled-drafts', 'expire_stale_scheduled_drafts'),
    ('recovered_runs', 'agent-recover-stale-runs', 'agent_recover_stale_runs'),
    ('abandoned_uploads', 'drive-cleanup-abandoned-uploads', 'drive_cleanup_abandoned_uploads'),
    ('reminders', 'send-due-reminders', 'send_due_reminders'),
    ('calendar_reminders', 'automation-calendar-reminders', 'fire_calendar_event_reminders'),
    ('calendar_started', 'automation-calendar-started', 'fire_calendar_event_started');
$$;

CREATE OR REPLACE FUNCTION public.maintenance_cron_active(p_job text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v boolean;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN RETURN false; END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1 AND active)' INTO v USING p_job;
  RETURN coalesce(v, false);
END $$;

-- Runs each maintenance task that has no active pg_cron job (where cron runs
-- it, the worker must not). Each task is isolated; one failure does not stop
-- the others.
CREATE OR REPLACE FUNCTION public.run_unscheduled_maintenance()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE t record; v_out jsonb := '{}'::jsonb; v_result text;
BEGIN
  FOR t IN SELECT * FROM maintenance_tasks() LOOP
    IF maintenance_cron_active(t.cron_job) THEN
      v_out := v_out || jsonb_build_object(t.task, 'pg_cron');
      CONTINUE;
    END IF;
    IF to_regprocedure('public.' || t.fn || '()') IS NULL THEN
      v_out := v_out || jsonb_build_object(t.task, 'not_installed');
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('SELECT public.%I()::text', t.fn) INTO v_result;
      v_out := v_out || jsonb_build_object(t.task, coalesce(v_result, 'done'));
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_object(t.task, 'error: ' || left(SQLERRM, 200));
    END;
  END LOOP;
  RETURN v_out;
END $$;

-- Readiness for health checks: database reachable (by being callable),
-- worker freshness and job progress, queue lag and dead jobs. Counts only.
CREATE OR REPLACE FUNCTION public.system_readiness()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'workers', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'worker', w.worker,
        'seconds_since_heartbeat', extract(epoch FROM now() - w.last_seen_at)::integer,
        'jobs_running', w.jobs_running,
        'jobs_completed', w.jobs_completed,
        'jobs_failed', w.jobs_failed,
        'seconds_since_last_job', extract(epoch FROM now() - w.last_job_finished_at)::integer) ORDER BY w.last_seen_at DESC)
      FROM worker_heartbeats w WHERE w.last_seen_at > now() - interval '1 hour'), '[]'::jsonb),
    'fresh_workers', (SELECT count(*) FROM worker_heartbeats WHERE last_seen_at > now() - interval '2 minutes'),
    'jobs_queued_due', (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_after <= now()),
    'oldest_due_job_seconds', (SELECT extract(epoch FROM now() - min(run_after))::integer FROM jobs WHERE status = 'queued' AND run_after <= now()),
    'jobs_running', (SELECT count(*) FROM jobs WHERE status = 'running'),
    'jobs_dead_24h', (SELECT count(*) FROM jobs WHERE status = 'dead' AND updated_at > now() - interval '24 hours'),
    'scheduler', (SELECT jsonb_object_agg(task, CASE WHEN maintenance_cron_active(cron_job) THEN 'pg_cron' ELSE 'worker' END)
                  FROM maintenance_tasks())
  );
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.worker_heartbeat(text, integer, bigint, bigint, timestamptz)', 'public.worker_stopped(text)',
    'public.maintenance_cron_active(text)', 'public.run_unscheduled_maintenance()', 'public.system_readiness()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
