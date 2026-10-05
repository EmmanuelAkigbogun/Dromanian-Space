// POST /api/agents/run — persist a run, queue it for the worker, and follow it
// as server-sent events. GET /api/agents/run?run_id=… reattaches to a run
// after a disconnect. Generation happens in the worker, so a closed tab or an
// API restart never stops or duplicates it.
import { RunRequest, startRun } from '../../server/agents/start.js';
import { enqueueRun, tailRun } from '../../server/agents/tail.js';
import { errorResponse, HttpError, readJson, sseResponse } from '../../server/http.js';
import { authenticate } from '../../server/supabase.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, RunRequest);
    const started = await startRun(user.id, body);
    if (!started.reused || started.status === 'queued') await enqueueRun(started.run_id, body.workspace_id, user.id);
    return sseResponse((channel) => {
      channel.send('run', started);
      void tailRun(started.run_id, user.id, channel);
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const runId = new URL(request.url).searchParams.get('run_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new HttpError(400, 'invalid_request', 'run_id is required.');
    return sseResponse((channel) => {
      void tailRun(runId, user.id, channel);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
