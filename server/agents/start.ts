import { z } from 'zod';
import { rpc } from '../supabase.js';

const uuid = z.string().uuid();

export const RunRequest = z.object({
  workspace_id: uuid,
  agent_id: uuid,
  conversation_id: uuid.nullish(),
  message: z.string().trim().min(1).max(20000),
  scope: z
    .object({
      item_ids: z.array(uuid).max(20).optional(),
      channel_id: uuid.optional(),
      thread_root_id: uuid.optional(),
    })
    .optional(),
  origin: z
    .object({
      type: z.enum(['home', 'agents', 'channel', 'thread', 'drive', 'crm', 'search']),
      id: z.string().max(100).optional(),
    })
    .optional(),
  trigger: z.enum(['interactive', 'thread_summary']).optional(),
  /** Client-generated; repeating a request with the same key returns the same run. */
  idempotency_key: z.string().min(8).max(100),
});
export type RunRequest = z.infer<typeof RunRequest>;

export interface StartedRun {
  run_id: string;
  conversation_id: string;
  input_message_id: string;
  output_message_id: string;
  status: string;
  reused: boolean;
}

/** Persists the conversation, prompt and run before any generation starts. */
export async function startRun(actorId: string, body: RunRequest): Promise<StartedRun> {
  return rpc<StartedRun>('agent_start_run', {
    p_actor: actorId,
    p_workspace_id: body.workspace_id,
    p_agent_id: body.agent_id,
    p_conversation_id: body.conversation_id ?? null,
    p_message: body.message,
    p_scope: body.scope ?? {},
    p_trigger: body.trigger ?? 'interactive',
    p_origin: body.origin ?? { type: 'agents' },
    p_destination: { type: 'private' },
    p_idempotency_key: `${actorId}:${body.idempotency_key}`,
    p_estimated_tokens: 20000,
  });
}

interface MentionTarget {
  agent_id: string;
  handle: string;
  agent_name: string;
  workspace_id: string;
  channel_id: string;
  thread_root_id: string;
  content: string;
  is_direct: boolean;
}

/**
 * Starts one run per agent a chat message mentions. The database decides what
 * counts as a valid mention (author, recency, no agent authors, active and
 * visible agents); the idempotency key makes repeated deliveries harmless.
 */
export async function startMentionRuns(actorId: string, messageId: string): Promise<Array<StartedRun & { handle: string; workspace_id: string }>> {
  const targets = await rpc<MentionTarget[]>('agent_mention_targets', { p_actor: actorId, p_message_id: messageId });
  const runs: Array<StartedRun & { handle: string; workspace_id: string }> = [];
  for (const t of targets) {
    const started = await rpc<StartedRun>('agent_start_run', {
      p_actor: actorId,
      p_workspace_id: t.workspace_id,
      p_agent_id: t.agent_id,
      p_conversation_id: null,
      p_message: t.content,
      p_scope: { channel_id: t.channel_id, thread_root_id: t.thread_root_id },
      p_trigger: 'mention',
      p_origin: { type: 'thread', channel_id: t.channel_id, message_id: messageId, thread_root_id: t.thread_root_id },
      p_destination: { type: 'channel', channel_id: t.channel_id, parent_id: t.thread_root_id },
      p_idempotency_key: `mention:${messageId}:${t.agent_id}`,
      p_estimated_tokens: 20000,
    });
    runs.push({ ...started, handle: t.handle, workspace_id: t.workspace_id });
  }
  return runs;
}
