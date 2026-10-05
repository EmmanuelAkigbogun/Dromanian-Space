// POST /api/agents/run — start (or resume watching) an agent run and stream it
// as server-sent events. The run is persisted before generation and keeps
// going if the client disconnects; clients recover it from the database.
import { waitUntil } from '@vercel/functions';
import { executeRun } from '../../server/agents/engine.js';
import { RunRequest, startRun } from '../../server/agents/start.js';
import { errorResponse, readJson, sseResponse } from '../../server/http.js';
import { log } from '../../server/log.js';
import { authenticate } from '../../server/supabase.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, RunRequest);
    const started = await startRun(user.id, body);
    return sseResponse((channel) => {
      channel.send('run', started);
      if (started.reused && started.status !== 'queued') {
        channel.send('done', { status: started.status });
        channel.close();
        return;
      }
      const work = executeRun(started.run_id, { events: { emit: channel.send } })
        .catch((err) => {
          log.error('run execution crashed', { run_id: started.run_id, error: err instanceof Error ? err : String(err) });
          channel.send('done', { status: 'failed', error_code: 'internal' });
        })
        .finally(() => channel.close());
      waitUntil(work);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
