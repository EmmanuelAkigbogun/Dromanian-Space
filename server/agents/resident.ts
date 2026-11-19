// A permanent AI member: at each conversation's summary time the day's notes
// session is closed and summarised, task requests go for approval, and a new
// session opens straight away so the AI never leaves the group.
import { rpc } from '../database.js';
import { log } from '../log.js';

export const DAILY_SUMMARY_PROMPT =
  'It is the end of the day in this group, and you are its permanent AI member. Write the daily summary for everyone in the conversation: ' +
  'for each person who posted today, what they finished, what is in progress and any blockers; then the decisions taken and the open questions. Keep it short and scannable, with one line per item. ' +
  'Human messages are authoritative. Resolve ownership from the conversation: a first-person commitment such as “I will…” belongs to its speaker; in a group a request needs a named or otherwise explicit recipient. Never default an unclear owner to the requester; keep it unassigned and say what is missing in the task description. ' +
  'You MUST call submit_tasks_for_approval exactly once with the complete list of actionable follow-ups. If there are none, call it with an empty list so the outcome is recorded. Only say tasks were sent after the tool confirms it. ' +
  'End by saying the proposed tasks are shown as cards below this message and under Tasks → Approvals.';

interface Rollover {
  status: 'not_resident' | 'requester_left' | 'started' | 'quiet' | 'summarize';
  session_id?: string;
  actor?: string;
  attempt?: number;
}

/** Called from the worker's maintenance loop; does nothing until a summary is due. */
export async function runResidentSummaries(): Promise<number> {
  const due = await rpc<{ channel_id: string }[]>('ai_resident_claim_due');
  let started = 0;
  for (const { channel_id } of due) {
    try {
      const rollover = await rpc<Rollover>('ai_resident_rollover', { p_channel_id: channel_id });
      if (rollover.status !== 'summarize' || !rollover.session_id || !rollover.actor) {
        if (rollover.status === 'requester_left') log.warn('permanent AI paused: the member who enabled it left', { channel_id });
        continue;
      }
      try {
        await rpc('ai_session_start_run', {
          p_actor: rollover.actor,
          p_session_id: rollover.session_id,
          p_phase: 'final',
          p_message: DAILY_SUMMARY_PROMPT,
          p_estimated_tokens: 20000,
        });
        started++;
      } catch (err) {
        // Leaves the finished session retryable from its Retry button.
        await rpc('ai_session_fail_notes_attempt', { p_session_id: rollover.session_id, p_attempt: rollover.attempt, p_run_id: null }).catch(() => undefined);
        log.warn('daily summary could not start', { channel_id, error: err instanceof Error ? err : String(err) });
      }
    } catch (err) {
      log.warn('daily summary rollover failed', { channel_id, error: err instanceof Error ? err : String(err) });
    }
  }
  return started;
}
