// POST /api/agents/mention — the author of a chat message that mentions agents
// asks for their replies. Runs execute in the background; replies arrive in
// the thread (or as a review card / private result, per audience and policy).
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { executeRun } from '../../server/agents/engine.js';
import { startMentionRuns } from '../../server/agents/start.js';
import { errorResponse, json, readJson } from '../../server/http.js';
import { log } from '../../server/log.js';
import { authenticate } from '../../server/supabase.js';

const Body = z.object({ message_id: z.string().uuid() });

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const { message_id } = await readJson(request, Body);
    const runs = await startMentionRuns(user.id, message_id);
    const pending = runs.filter((r) => !r.reused || r.status === 'queued');
    if (pending.length > 0) {
      waitUntil(
        Promise.all(
          pending.map((r) =>
            executeRun(r.run_id).catch((err) =>
              log.error('mention run crashed', { run_id: r.run_id, error: err instanceof Error ? err : String(err) }),
            ),
          ),
        ),
      );
    }
    return json(
      { runs: runs.map((r) => ({ run_id: r.run_id, conversation_id: r.conversation_id, handle: r.handle, status: r.status, reused: r.reused })) },
      202,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
