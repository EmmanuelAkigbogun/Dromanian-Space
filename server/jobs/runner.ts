import { rpc } from '../supabase.js';
import { log } from '../log.js';
import { handleKnowledgeExtract } from '../knowledge/worker.js';
import { handleDrivePurge, handleGcObject } from '../drive/gc.js';
import { executeRun } from '../agents/engine.js';
import { PermanentJobError, type JobHandler, type JobRow } from './types.js';

const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;

/** Agent runs: a restarted worker reclaims the run through its expired lease. */
const handleAgentRun: JobHandler = async (job, ctx) => {
  const runId = String(job.payload.run_id ?? '');
  if (!runId) throw new PermanentJobError('Job has no run_id');
  const outcome = await executeRun(runId, { worker: ctx.worker });
  if (outcome.status === 'running_elsewhere' || outcome.status === 'lost') {
    throw new Error(`Run ${runId} is held by another worker`);
  }
  return { status: outcome.status, error_code: outcome.error_code ?? null };
};

const handlers: Record<string, JobHandler> = {
  'agent.run': handleAgentRun,
  'knowledge.extract': handleKnowledgeExtract,
  'drive.purge': handleDrivePurge,
  'drive.gc_object': handleGcObject,
};

export const JOB_KINDS = Object.keys(handlers);

export type JobOutcome = 'succeeded' | 'queued' | 'failed' | 'dead' | 'lease_lost';

export async function runJob(job: JobRow, worker: string, deadline: number): Promise<JobOutcome> {
  const handler = handlers[job.kind];
  const controller = new AbortController();
  const beat = setInterval(async () => {
    try {
      const alive = await rpc<boolean>('heartbeat_job', { p_job_id: job.id, p_worker: worker, p_lease_seconds: LEASE_SECONDS });
      if (!alive) controller.abort();
    } catch {
      /* the next beat or the lease expiry decides */
    }
  }, HEARTBEAT_MS);
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));

  try {
    if (!handler) throw new PermanentJobError(`No handler for job kind ${job.kind}`);
    const result = await handler(job, { worker, signal: controller.signal, isLastAttempt: job.attempts >= job.max_attempts });
    const completed = await rpc<boolean>('complete_job', { p_job_id: job.id, p_worker: worker, p_result: result });
    return completed ? 'succeeded' : 'lease_lost';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('job failed', { job_id: job.id, kind: job.kind, attempt: job.attempts, error: message });
    const status = await rpc<string>('fail_job', {
      p_job_id: job.id,
      p_worker: worker,
      p_error: message.slice(0, 1000),
      p_retry: !(err instanceof PermanentJobError),
    });
    return (status === 'not_leased' ? 'lease_lost' : status) as JobOutcome;
  } finally {
    clearInterval(beat);
    clearTimeout(timeout);
  }
}

export interface DrainOptions {
  worker: string;
  /** Epoch ms after which no new job is claimed. */
  deadline: number;
  workspaceId?: string;
  kinds?: string[];
  maxJobs?: number;
  /** Wait briefly for debounced document indexing after an interactive save. */
  waitForQueuedMs?: number;
}

export interface DrainSummary {
  claimed: number;
  outcomes: Record<string, number>;
}

/** Claims and runs jobs until the queue is empty, the deadline passes or maxJobs is reached. */
export async function drainQueue(options: DrainOptions): Promise<DrainSummary> {
  const kinds = (options.kinds ?? JOB_KINDS).filter((k) => k in handlers);
  const summary: DrainSummary = { claimed: 0, outcomes: {} };
  const maxJobs = options.maxJobs ?? 100;
  const waitUntil = Date.now() + (options.waitForQueuedMs ?? 0);
  while (Date.now() < options.deadline - 5000 && summary.claimed < maxJobs) {
    const batch = 1; // Jobs execute sequentially: never let later claims expire while waiting.
    const jobs = options.workspaceId
      ? await rpc<JobRow[]>('claim_workspace_jobs', {
          p_worker: options.worker,
          p_workspace_id: options.workspaceId,
          p_kinds: kinds,
          p_limit: batch,
          p_lease_seconds: LEASE_SECONDS,
        })
      : await rpc<JobRow[]>('claim_jobs', { p_worker: options.worker, p_kinds: kinds, p_limit: batch, p_lease_seconds: LEASE_SECONDS });
    if (!jobs || jobs.length === 0) {
      if (Date.now() < waitUntil) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      break;
    }
    summary.claimed += jobs.length;
    for (const job of jobs) {
      const outcome = await runJob(job, options.worker, options.deadline);
      summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    }
  }
  return summary;
}

/**
 * Database maintenance the worker is responsible for: each task runs here
 * only when no active pg_cron job runs it (one authoritative scheduler per task).
 */
export async function runMaintenance(): Promise<Record<string, unknown>> {
  return rpc<Record<string, unknown>>('run_unscheduled_maintenance');
}
