// GET /api/ready — readiness for orchestration and monitoring. Ready means the
// database answers, at least one worker sent a heartbeat in the last two
// minutes, and due jobs are not piling up. Counts only; no secrets or content.
import { json } from '../server/http.js';
import { providerStates } from '../server/ai/registry.js';
import { rpc } from '../server/database.js';

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
  const crewUrl = process.env.CREWAI_URL?.replace(/\/$/, '');
  let crew = 'ok';
  if (crewUrl) {
    try {
      const response = await fetch(`${crewUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) crew = `HTTP ${response.status}`;
    } catch {
      crew = 'unreachable';
    }
  }
  const checks = {
    database: 'ok',
    worker: state.fresh_workers > 0 ? 'ok' : 'no recent heartbeat',
    queue: (state.oldest_due_job_seconds ?? 0) <= MAX_QUEUE_LAG_SECONDS ? 'ok' : `oldest due job waiting ${state.oldest_due_job_seconds}s`,
    ...(crewUrl ? { crew } : {}),
  };
  const ready = Object.values(checks).every((c) => c === 'ok');
  // Informational: a missing AI key is a setup state, not an outage.
  const ai = Object.fromEntries(providerStates().map((p) => [p.name, p.configured ? 'configured' : 'not configured']));
  return json({ ready, checks, ai_providers: ai, ...state }, ready ? 200 : 503);
}
