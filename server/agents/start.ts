import { z } from 'zod';
import { databasePool, rpc } from '../database.js';
import { HttpError } from '../http.js';

const uuid = z.string().uuid();
const MAX_AGENT_IMAGE_BYTES = 10 * 1024 * 1024;
const AgentImage = z.object({
  path: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  size: z.number().int().positive().max(MAX_AGENT_IMAGE_BYTES),
});

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
      attachments: z.array(AgentImage).max(4).optional(),
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

async function verifyAgentImages(actorId: string, attachments: z.infer<typeof AgentImage>[] | undefined): Promise<void> {
  if (!attachments?.length) return;
  const expectedPrefix = `agent-images/${actorId}/`;
  if (attachments.some((item) => !item.path.startsWith(expectedPrefix) || item.path.includes('..') || item.path.includes('\\'))) {
    throw new HttpError(400, 'invalid_attachment', 'An attached image has an invalid storage path.');
  }
  const paths = attachments.map((item) => item.path);
  if (new Set(paths).size !== paths.length) throw new HttpError(400, 'invalid_attachment', 'The same image was attached more than once.');
  const rows = await databasePool().query<{ name: string; metadata: { size?: number; mimetype?: string } | null }>(
    `SELECT name, metadata FROM storage.objects
      WHERE bucket_id = 'message-attachments' AND name = ANY($1::text[])
        AND (owner = $2::uuid OR owner_id = $2::text)`,
    [paths, actorId],
  );
  const stored = new Map(rows.rows.map((row) => [row.name, row.metadata ?? {}]));
  for (const item of attachments) {
    const metadata = stored.get(item.path);
    if (!metadata || Number(metadata.size) !== item.size || metadata.mimetype !== item.mime_type) {
      throw new HttpError(400, 'invalid_attachment', 'An attached image is missing or does not match the uploaded file.');
    }
  }
}

/** Persists the conversation, prompt and run before any generation starts. */
export async function startRun(actorId: string, body: RunRequest): Promise<StartedRun> {
  await verifyAgentImages(actorId, body.scope?.attachments);
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
