// GET /api/ready — readiness for orchestration and monitoring. Ready means the
// database answers, at least one worker sent a heartbeat in the last two
// minutes, and due jobs are not piling up. Counts only; no secrets or content.
import { json } from '../server/http.js';
import { rpc } from '../server/supabase.js';

const MAX_QUEUE_LAG_SECONDS = Number(process.env.READY_MAX_QUEUE_LAG_SECONDS ?? 300);

interface Readiness {
  fresh_workers: number;
  oldest_due_job_seconds: number | null;
  jobs_queued_due: number;
  jobs_running: number;
  jobs_dead_24h: number;
  workers: unknown[];
  scheduler: Record<string, string>;
}

export async function GET(): Promise<Response> {
  let state: Readiness;
  try {
    state = await rpc<Readiness>('system_readiness');
  } catch {
    return json({ ready: false, checks: { database: 'unreachable' } }, 503);
  }
  const checks = {
    database: 'ok',
    worker: state.fresh_workers > 0 ? 'ok' : 'no recent heartbeat',
    queue: (state.oldest_due_job_seconds ?? 0) <= MAX_QUEUE_LAG_SECONDS ? 'ok' : `oldest due job waiting ${state.oldest_due_job_seconds}s`,
  };
  const ready = Object.values(checks).every((c) => c === 'ok');
  return json({ ready, checks, ...state }, ready ? 200 : 503);
}
