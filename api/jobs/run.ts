// Background work is done by the worker process (server/worker.ts), which
// polls the jobs table continuously and runs maintenance every minute.
//   GET  — optional external scheduler (Authorization: Bearer CRON_SECRET):
//          maintenance plus a bounded drain of short jobs. Safe to overlap
//          with the worker; jobs are leased.
//   POST — kept for clients that nudge after an upload; the worker already
//          picks new jobs up within seconds, so this only acknowledges.
import { z } from 'zod';
import { env } from '../../server/env.js';
import { errorResponse, HttpError, json, readJson } from '../../server/http.js';
import { drainQueue, JOB_KINDS, runMaintenance } from '../../server/jobs/runner.js';
import { authenticate, requireMember } from '../../server/supabase.js';

const BUDGET_MS = Number(process.env.JOBS_BUDGET_MS ?? 50_000);

export async function GET(request: Request): Promise<Response> {
  try {
    const secret = env().cronSecret;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
      throw new HttpError(401, 'unauthenticated', 'Not authorized.');
    }
    const maintenance = await runMaintenance();
    // Agent runs can take minutes; they belong to the worker, not a request.
    const kinds = JOB_KINDS.filter((k) => k !== 'agent.run');
    const queue = await drainQueue({ worker: env().workerId, kinds, deadline: Date.now() + BUDGET_MS });
    return json({ maintenance, queue });
  } catch (err) {
    return errorResponse(err);
  }
}

const Kick = z.object({ workspace_id: z.string().uuid() });

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const { workspace_id } = await readJson(request, Kick);
    await requireMember(workspace_id, user.id);
    return json({ accepted: true }, 202);
  } catch (err) {
    return errorResponse(err);
  }
}
