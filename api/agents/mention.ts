// POST /api/agents/mention — the author of a chat message that mentions agents
// asks for their replies. Runs are queued for the worker; replies arrive in
// the thread (or as a review card / private result, per audience and policy).
import { z } from 'zod';
import { startMentionRuns } from '../../server/agents/start.js';
import { enqueueRun } from '../../server/agents/tail.js';
import { errorResponse, json, readJson } from '../../server/http.js';
import { authenticate } from '../../server/supabase.js';

const Body = z.object({ message_id: z.string().uuid() });

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const { message_id } = await readJson(request, Body);
    const runs = await startMentionRuns(user.id, message_id);
    for (const r of runs) {
      if (!r.reused || r.status === 'queued') await enqueueRun(r.run_id, r.workspace_id, user.id);
    }
    return json(
      { runs: runs.map((r) => ({ run_id: r.run_id, conversation_id: r.conversation_id, handle: r.handle, status: r.status, reused: r.reused })) },
      202,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
