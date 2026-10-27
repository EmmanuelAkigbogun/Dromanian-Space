// POST /api/agents/sessions — a participant of a direct conversation invites
// Scribe ({action: "start"}) or ends the session ({action: "finish"}). While a
// session is active the agent may read the messages sent in it; finishing
// queues a run that posts the notes into the conversation and sends action
// items to the project managers. Both participants see the session change live.
import { z } from 'zod';
import type { StartedRun } from '../../server/agents/start.js';
import { enqueueRun } from '../../server/agents/tail.js';
import { authenticate, databasePool, rpc } from '../../server/database.js';
import { errorResponse, HttpError, json, readJson } from '../../server/http.js';

const uuid = z.string().uuid();
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), channel_id: uuid, agent_id: uuid.optional() }),
  z.object({ action: z.literal('finish'), session_id: uuid }),
]);

interface Session {
  id: string;
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  status: 'active' | 'finished';
  ended_by: string | null;
  message_count: number | null;
  notes_run_id: string | null;
}

const NOTES_PROMPT =
  'The AI session in this conversation has ended. Write the notes for both participants from the conversation snapshot: ' +
  'a short summary, decisions, action items (with owner and due date when known) and open questions. ' +
  'Send the action items to the project managers with submit_tasks_for_approval; if there are none, say so and submit nothing.';

async function noteTaker(channelId: string): Promise<string> {
  const found = await databasePool().query(
    `SELECT a.id FROM public.direct_conversations dc
       JOIN public.workspace_agents a ON a.workspace_id = dc.workspace_id AND a.template_key = 'cerebras_writer' AND a.is_builtin
      WHERE dc.channel_id = $1::uuid AND a.archived_at IS NULL`,
    [channelId],
  );
  if (!found.rowCount) throw new HttpError(404, 'agent_unavailable', 'The note-taking agent is not available in this workspace.');
  return found.rows[0].id;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, Body);
    if (body.action === 'start') {
      const agentId = body.agent_id ?? (await noteTaker(body.channel_id));
      const session = await rpc<Session>('ai_session_start', { p_actor: user.id, p_channel_id: body.channel_id, p_agent_id: agentId });
      return json({ session });
    }

    const session = await rpc<Session>('ai_session_finish', { p_actor: user.id, p_session_id: body.session_id });
    // Only the person who ended the session writes its notes (once).
    if (session.ended_by !== user.id || session.notes_run_id || !session.message_count) {
      return json({ session, notes: session.notes_run_id ? 'queued' : 'none' });
    }
    try {
      const run = await rpc<StartedRun>('agent_start_run', {
        p_actor: user.id,
        p_workspace_id: session.workspace_id,
        p_agent_id: session.agent_id,
        p_conversation_id: null,
        p_message: NOTES_PROMPT,
        p_scope: { channel_id: session.channel_id, session_id: session.id },
        p_trigger: 'session_notes',
        p_origin: { type: 'channel', channel_id: session.channel_id, session_id: session.id },
        p_destination: { type: 'channel', channel_id: session.channel_id, parent_id: null },
        p_idempotency_key: `session:${session.id}`,
        p_estimated_tokens: 20000,
      });
      await rpc('ai_session_attach_run', { p_session_id: session.id, p_run_id: run.run_id });
      if (!run.reused || run.status === 'queued') await enqueueRun(run.run_id, session.workspace_id, user.id);
      return json({ session: { ...session, notes_run_id: run.run_id }, notes: 'queued' });
    } catch (err) {
      // The session is over either way; say why there will be no notes.
      const message = err instanceof HttpError ? err.message : 'The notes could not be started.';
      return json({ session, notes: 'failed', error: message });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
