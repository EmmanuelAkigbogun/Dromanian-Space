import { authenticate, databasePool, jwtForRequest } from '../server/database.js';
import { HttpError } from '../server/http.js';
import { publishDatabaseChange } from '../server/events.js';

const restUrl = process.env.DATABASE_REST_URL?.trim() ?? 'http://rest:3000';
const forwardedResponseHeaders = ['content-type', 'content-range', 'preference-applied', 'location'];

function stringField(row: Record<string, unknown>, name: string): string | null {
  return typeof row[name] === 'string' ? row[name] as string : null;
}

async function workspaceAudience(workspaceId: string): Promise<string[]> {
  const result = await databasePool().query(
    'SELECT user_id FROM public.workspace_members WHERE workspace_id = $1::uuid',
    [workspaceId],
  );
  return result.rows.map((row) => row.user_id);
}

async function channelAudience(channelId: string): Promise<string[]> {
  const result = await databasePool().query(
    `SELECT wm.user_id
       FROM public.channels c
       JOIN public.workspace_members wm ON wm.workspace_id = c.workspace_id
      WHERE c.id = $1::uuid AND c.is_private = false
     UNION
     SELECT cm.user_id FROM public.channel_members cm WHERE cm.channel_id = $1::uuid`,
    [channelId],
  );
  return result.rows.map((row) => row.user_id);
}

async function mutationAudience(table: string, row: Record<string, unknown>, actorId: string): Promise<string[]> {
  const explicitUser = ['to_user_id', 'recipient_id'].map((key) => stringField(row, key)).find(Boolean);
  if (explicitUser) return [...new Set([actorId, explicitUser])];

  const privateUserTables = new Set([
    'notifications', 'notification_preferences', 'saved_messages', 'scheduled_messages',
    'reminders', 'agent_personal_notes', 'user_preferences',
  ]);
  if (privateUserTables.has(table)) {
    const userId = stringField(row, 'user_id');
    return [...new Set([actorId, ...(userId ? [userId] : [])])];
  }

  if (table === 'profiles') {
    const profileId = stringField(row, 'id');
    if (!profileId) return [actorId];
    const result = await databasePool().query(
      `SELECT DISTINCT audience.user_id
         FROM public.workspace_members subject
         JOIN public.workspace_members audience ON audience.workspace_id = subject.workspace_id
        WHERE subject.user_id = $1::uuid`,
      [profileId],
    );
    return [...new Set([actorId, profileId, ...result.rows.map((entry) => entry.user_id)])];
  }

  let channelId = table === 'channels' ? stringField(row, 'id') : stringField(row, 'channel_id');
  const messageTables = new Set(['reactions', 'file_attachments', 'message_versions', 'message_read_receipts']);
  if (!channelId && messageTables.has(table)) {
    const messageId = stringField(row, 'message_id');
    if (messageId) {
      channelId = (await databasePool().query('SELECT channel_id FROM public.messages WHERE id = $1::uuid', [messageId])).rows[0]?.channel_id ?? null;
    }
  }
  if (!channelId && table === 'direct_conversation_participants') {
    const conversationId = stringField(row, 'conversation_id');
    if (conversationId) {
      channelId = (await databasePool().query('SELECT channel_id FROM public.direct_conversations WHERE id = $1::uuid', [conversationId])).rows[0]?.channel_id ?? null;
    }
  }
  if (channelId) {
    const users = await channelAudience(channelId);
    const rowUser = stringField(row, 'user_id');
    return [...new Set([actorId, ...(rowUser ? [rowUser] : []), ...users])];
  }

  const workspaceWideTables = new Set(['workspace_members', 'workspace_settings']);
  const workspaceId = stringField(row, 'workspace_id');
  if (workspaceId && workspaceWideTables.has(table)) {
    return [...new Set([actorId, ...await workspaceAudience(workspaceId)])];
  }

  const projectId = table === 'projects' ? stringField(row, 'id') : stringField(row, 'project_id');
  if (projectId) {
    const result = await databasePool().query(
      `SELECT wm.user_id
         FROM public.workspace_members wm
         JOIN public.projects p ON p.workspace_id = wm.workspace_id
        WHERE p.id = $1::uuid AND public.is_project_readable(p.id, wm.user_id)`,
      [projectId],
    );
    return [...new Set([actorId, ...result.rows.map((entry) => entry.user_id)])];
  }

  // Unknown and owner-private tables never fan out. Their callers still get
  // their own mutation event, while other clients refresh on navigation/poll.
  return [actorId];
}

export async function proxyDatabase(request: Request, suffix: string): Promise<Response> {
  const user = await authenticate(request);
  if (!/^(?:rpc\/)?[a-zA-Z_][a-zA-Z0-9_]*$/.test(suffix)) throw new HttpError(404, 'not_found', 'Database resource not found.');
  const source = new URL(request.url);
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'prefer', 'range', 'range-unit']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${jwtForRequest(user)}`);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(`${restUrl}/${suffix}${source.search}`, { method: request.method, headers, body, signal: AbortSignal.timeout(30_000) });
  const responseBody = upstream.status === 204 || request.method === 'HEAD' ? null : await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  for (const name of forwardedResponseHeaders) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (upstream.ok && !suffix.startsWith('rpc/') && ['POST', 'PATCH', 'DELETE'].includes(request.method)) {
    const type = request.method === 'POST' ? 'INSERT' : request.method === 'PATCH' ? 'UPDATE' : 'DELETE';
    let rows: unknown = null;
    try { rows = responseBody?.byteLength ? JSON.parse(Buffer.from(responseBody).toString('utf8')) : null; } catch { /* no representation requested */ }
    const list = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const audience = await mutationAudience(suffix, row as Record<string, unknown>, user.id);
      publishDatabaseChange(suffix, type, row, audience);
    }
  }
  return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
}

