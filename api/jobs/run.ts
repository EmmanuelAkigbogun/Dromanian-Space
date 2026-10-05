// Background work: knowledge extraction, Drive purge/GC and maintenance.
//   GET  — Vercel Cron (Authorization: Bearer CRON_SECRET): maintenance + queue.
//   POST — a signed-in member nudges their workspace's queue (e.g. right after
//          an upload) instead of waiting for the next scheduled run.
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { env } from '../../server/env.js';
import { errorResponse, HttpError, json, readJson } from '../../server/http.js';
import { drainQueue, runMaintenance } from '../../server/jobs/runner.js';
import { authenticate, requireMember } from '../../server/supabase.js';

const FUNCTION_BUDGET_MS = Number(process.env.JOBS_BUDGET_MS ?? 240_000);

export async function GET(request: Request): Promise<Response> {
  try {
    const secret = env().cronSecret;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
      throw new HttpError(401, 'unauthenticated', 'Not authorized.');
    }
    const maintenance = await runMaintenance();
    const summary = await drainQueue({ worker: env().workerId, deadline: Date.now() + FUNCTION_BUDGET_MS });
    return json({ maintenance, queue: summary });
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
    waitUntil(
      drainQueue({ worker: env().workerId, workspaceId: workspace_id, deadline: Date.now() + 60_000, maxJobs: 10, waitForQueuedMs: 25_000 }).catch(() => undefined),
    );
    return json({ accepted: true }, 202);
  } catch (err) {
    return errorResponse(err);
  }
}
