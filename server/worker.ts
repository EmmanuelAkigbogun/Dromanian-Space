// Durable background worker: agent runs, knowledge extraction, Drive purge/GC
// and maintenance. Work is claimed from the jobs table with leases, so several
// workers can run side by side and a restarted worker's jobs are picked up
// again once their leases expire (agent runs restart cleanly).
import { writeFile } from 'node:fs/promises';
import { env } from './env.js';
import { log } from './log.js';
import { rpc } from './supabase.js';
import { JOB_KINDS, runJob, runMaintenance } from './jobs/runner.js';
import type { JobRow } from './jobs/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WorkerOptions {
  concurrency?: number;
  pollMs?: number;
  maintenanceMs?: number;
  /** Touched on every loop so a container health check can tell the worker is alive. */
  aliveFile?: string | null;
}

export interface RunningWorker {
  stop(graceMs?: number): Promise<void>;
}

export function startWorker(options: WorkerOptions = {}): RunningWorker {
  const worker = env().workerId;
  const concurrency = Math.max(1, options.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4));
  const pollMs = options.pollMs ?? 1000;
  const maintenanceMs = options.maintenanceMs ?? 60_000;
  const aliveFile = options.aliveFile === undefined ? (process.env.WORKER_ALIVE_FILE ?? '/tmp/worker-alive') : options.aliveFile;
  const heartbeatMs = 15_000;
  const inFlight = new Set<Promise<unknown>>();
  const stats = { completed: 0, failed: 0, lastFinished: null as string | null };
  let stopping = false;
  let lastMaintenance = 0;
  let lastHeartbeat = 0;

  const loop = (async () => {
    log.info('worker started', { worker, concurrency, kinds: JOB_KINDS });
    while (!stopping) {
      try {
        if (aliveFile) await writeFile(aliveFile, String(Date.now())).catch(() => undefined);
        if (Date.now() - lastHeartbeat > heartbeatMs) {
          lastHeartbeat = Date.now();
          // Readiness checks look at this heartbeat and at job progress, not just the process.
          await rpc('worker_heartbeat', {
            p_worker: worker,
            p_running: inFlight.size,
            p_completed: stats.completed,
            p_failed: stats.failed,
            p_last_finished: stats.lastFinished,
          }).catch((err) => log.warn('heartbeat failed', { error: err instanceof Error ? err : String(err) }));
        }
        if (Date.now() - lastMaintenance > maintenanceMs) {
          lastMaintenance = Date.now();
          const result = await runMaintenance();
          log.info('maintenance', result);
        }
        if (inFlight.size < concurrency) {
          const [job] = await rpc<JobRow[]>('claim_jobs', { p_worker: worker, p_kinds: JOB_KINDS, p_limit: 1, p_lease_seconds: 120 });
          if (job) {
            const task = runJob(job, worker, Date.now() + 60 * 60_000)
              .then((outcome) => {
                if (outcome === 'succeeded') stats.completed++;
                else stats.failed++;
                stats.lastFinished = new Date().toISOString();
                log.info('job finished', { job_id: job.id, kind: job.kind, outcome });
              })
              .catch((err) => log.error('job crashed', { job_id: job.id, error: err instanceof Error ? err : String(err) }))
              .finally(() => inFlight.delete(task));
            inFlight.add(task);
            continue;
          }
        }
      } catch (err) {
        log.error('worker loop error', { error: err instanceof Error ? err : String(err) });
      }
      await sleep(pollMs);
    }
  })();

  return {
    async stop(graceMs = 25_000) {
      stopping = true;
      await loop;
      await Promise.race([Promise.allSettled([...inFlight]), sleep(graceMs)]);
      // Unfinished jobs keep their leases until they expire (two minutes), then
      // another worker resumes them; agent runs restart from their persisted input.
      await rpc('worker_stopped', { p_worker: worker }).catch(() => undefined);
      log.info('worker stopped', { worker, unfinished: inFlight.size });
    },
  };
}
