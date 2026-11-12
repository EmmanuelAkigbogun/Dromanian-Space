// POST /api/agents/sessions — a participant of a direct conversation or the
// canonical #general channel invites the notes agent, asks it for a
// non-mutating review, then explicitly finishes. The session stays open after
// review so people can answer questions before final notes submit task requests.
import { z } from 'zod';
import { authenticate, databasePool, rpc } from '../../server/database.js';
import { errorResponse, HttpError, json, readJson } from '../../server/http.js';

const uuid = z.string().uuid();
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), channel_id: uuid, agent_id: uuid.optional() }),
  z.object({ action: z.literal('review'), session_id: uuid }),
  z.object({ action: z.literal('finish'), session_id: uuid }),
  z.object({ action: z.literal('cancel'), session_id: uuid }),
]);

interface Session {
  id: string;
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  started_by: string;
  status: 'active' | 'finished';
  ended_by: string | null;
  message_count: number | null;
  review_run_id: string | null;
  review_requested_at: string | null;
  review_requested_by: string | null;
  review_status: 'reserving' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null;
  review_attempt: number;
  notes_run_id: string | null;
  notes_requested_by: string | null;
  notes_status: 'reserving' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null;
  notes_attempt: number;
  abandoned_by: string | null;
  abandoned_at: string | null;
}

const REVIEW_PROMPT =
  'Review this conversation AI session while it remains open. Do not submit or create tasks in this review. ' +
  'Give everyone in the conversation a short summary of the decisions and likely action items, with the correct owner only when the conversation supports one. ' +
  'Ask only concise questions whose answers would materially change an owner, scope, deliverable, due date or project. ' +
  'If nothing blocks accurate task preparation, say that the session is ready to finish. The participants will answer in this same conversation.';

const NOTES_PROMPT =
  'The conversation reviewed this AI session and it has now been finished. Use any human clarification replies that are present; do not claim unanswered questions were answered. ' +
  'Write final notes for everyone in the conversation: a short summary, decisions and actionable items. ' +
  'The earlier agent review in the transcript is a provisional draft. Human messages and clarification replies are authoritative; correct the draft when they conflict. ' +
  'Resolve ownership from conversation roles: in a two-person direct conversation, a second-person request such as “please do…” or “I would like you to…” belongs to the other person, not automatically to the speaker; in a group channel it needs a named or otherwise explicit recipient. A first-person commitment such as “I will…” belongs to that speaker; a person mentioned for coordination is not automatically a co-owner. ' +
  'Never default an unclear owner to the requester. Keep an unresolved owner unassigned and explain the missing detail in that task description. ' +
  'You MUST call submit_tasks_for_approval exactly once with the complete actionable list. If there are no action items, call it with an empty tasks list so that outcome is durably recorded. A final response without that successful tool outcome will fail and be retried. Only say tasks were sent after the tool confirms persistence. ' +
  'List the submitted items and tell participants to open Tasks → Approvals. If there are no action items, clearly say the empty outcome was recorded.';

async function noteTaker(channelId: string): Promise<string> {
  const found = await databasePool().query(
    `SELECT agent.id
       FROM public.channels channel
       JOIN public.workspace_agents agent
         ON agent.workspace_id = channel.workspace_id
        AND agent.template_key = 'cerebras_writer'
        AND agent.is_builtin
      WHERE channel.id = $1::uuid
        AND channel.archived_at IS NULL
        AND agent.archived_at IS NULL
        AND (
          channel.slug = 'general'
          OR EXISTS (
            SELECT 1 FROM public.direct_conversations conversation
            WHERE conversation.channel_id = channel.id
          )
        )`,
    [channelId],
  );
  if (!found.rowCount) throw new HttpError(404, 'agent_unavailable', 'The note-taking agent is not available in this workspace.');
  return found.rows[0].id;
}

async function startSessionRun(
  userId: string,
  session: Session,
  phase: 'review' | 'final',
): Promise<Session> {
  return rpc<Session>('ai_session_start_run', {
    p_actor: userId,
    p_session_id: session.id,
    p_phase: phase,
    p_message: phase === 'review' ? REVIEW_PROMPT : NOTES_PROMPT,
    p_estimated_tokens: phase === 'review' ? 12000 : 20000,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, Body);
    if (body.action === 'start') {
      // agent_id remains accepted for old clients, but cannot select another
      // agent for a privileged notes-session scope.
      const agentId = await noteTaker(body.channel_id);
      const session = await rpc<Session>('ai_session_start', { p_actor: user.id, p_channel_id: body.channel_id, p_agent_id: agentId });
      return json({ session });
    }

    if (body.action === 'cancel') {
      const session = await rpc<Session>('ai_session_abandon', {
        p_actor: user.id,
        p_session_id: body.session_id,
      });
      const runIds = [...new Set([session.review_run_id, session.notes_run_id].filter((id): id is string => Boolean(id)))].sort();
      for (const runId of runIds) {
        // Terminal states are idempotent, while a genuine cancellation error
        // must reach the caller instead of reporting a false-safe success.
        await rpc('ai_session_cancel_abandoned_run', {
          p_actor: user.id,
          p_session_id: session.id,
          p_run_id: runId,
        });
      }
      return json({ cancelled: true });
    }

    if (body.action === 'review') {
      const reserved = await rpc<Session>('ai_session_request_review', {
        p_actor: user.id,
        p_session_id: body.session_id,
      });
      if (reserved.review_status === 'completed') return json({ session: reserved, review: 'ready' });
      if (reserved.review_run_id) {
        return json({ session: reserved, review: 'queued' });
      }
      try {
        const session = await startSessionRun(user.id, reserved, 'review');
        return json({ session, review: 'queued' });
      } catch (err) {
        const session = await rpc<Session>('ai_session_fail_review_reservation', {
          p_session_id: reserved.id,
          p_attempt: reserved.review_attempt,
        }).catch(() => reserved);
        if (session.review_status === 'completed') return json({ session, review: 'ready' });
        if (session.review_status === 'queued' || session.review_status === 'running') {
          return json({ session, review: 'queued' });
        }
        const message = err instanceof HttpError ? err.message : 'The session review could not be started.';
        return json({ session, review: 'failed', error: message });
      }
    }

    let prepared: Session;
    try {
      prepared = await rpc<Session>('ai_session_request_finish', {
        p_actor: user.id,
        p_session_id: body.session_id,
      });
    } catch (err) {
      if (err instanceof HttpError
          && /Review this session before finishing it/.test(err.message)) {
        throw new HttpError(
          409,
          'session_review_required',
          'Review this session before finishing it. If you do not see the Review button, refresh the app to load the updated notes workflow.',
        );
      }
      throw err;
    }
    if (!prepared.message_count) {
      const session = prepared.status === 'finished'
        ? prepared
        : await rpc<Session>('ai_session_finish', {
          p_actor: user.id,
          p_session_id: prepared.id,
        });
      return json({ session, notes: 'none' });
    }
    if (prepared.notes_status === 'completed') {
      return json({ session: prepared, notes: 'ready' });
    }
    if (prepared.notes_run_id && (prepared.notes_status === 'queued' || prepared.notes_status === 'running')) {
      return json({ session: prepared, notes: 'queued' });
    }
    try {
      const session = await startSessionRun(user.id, prepared, 'final');
      return json({ session, notes: 'queued' });
    } catch (err) {
      const session = await rpc<Session>('ai_session_fail_notes_attempt', {
        p_session_id: prepared.id,
        p_attempt: prepared.notes_attempt,
        p_run_id: null,
      }).catch(() => prepared);
      if (session.notes_status === 'completed') return json({ session, notes: 'ready' });
      if (session.notes_status === 'queued' || session.notes_status === 'running') {
        return json({ session, notes: 'queued' });
      }
      const message = err instanceof HttpError ? err.message : 'The notes could not be started.';
      return json({ session, notes: 'failed', error: message });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
