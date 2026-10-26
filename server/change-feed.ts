// Streams rows that database functions write (notifications, agent replies,
// AI sessions, task requests, receipts) to the people allowed to see them. The data
// proxy only publishes the browser's own table writes; these rows are
// announced by triggers with pg_notify('app_changes', …) and fetched here.
// Every API instance listens on its own connection and serves its own clients.
import pg from 'pg';
import { databasePool } from './database.js';
import { publishDatabaseChange } from './events.js';
import { log } from './log.js';

interface Change {
  table: string;
  event: 'INSERT' | 'UPDATE';
  id: string;
}

const RECONNECT_MS = 5000;
let client: pg.Client | null = null;
let starting = false;

async function channelMembers(channelId: string): Promise<string[]> {
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

/** The row and who may see it, or null when it no longer exists. */
async function load(change: Change): Promise<{ row: Record<string, unknown>; audience: string[] } | null> {
  const db = databasePool();
  if (change.table === 'notifications') {
    const row = (await db.query('SELECT * FROM public.notifications WHERE id = $1::uuid', [change.id])).rows[0];
    return row ? { row, audience: [row.user_id] } : null;
  }
  if (change.table === 'messages') {
    const row = (await db.query('SELECT * FROM public.messages WHERE id = $1::uuid', [change.id])).rows[0];
    return row ? { row, audience: await channelMembers(row.channel_id) } : null;
  }
  if (change.table === 'channel_members') {
    // Receipts: how far a member has received and read a conversation.
    const row = (await db.query(
      'SELECT id, channel_id, user_id, last_read_at, greatest(last_delivered_at, last_read_at) AS last_delivered_at FROM public.channel_members WHERE id = $1::uuid',
      [change.id])).rows[0];
    return row ? { row, audience: await channelMembers(row.channel_id) } : null;
  }
  if (change.table === 'conversation_ai_sessions') {
    const row = (await db.query('SELECT * FROM public.conversation_ai_sessions WHERE id = $1::uuid', [change.id])).rows[0];
    return row ? { row, audience: await channelMembers(row.channel_id) } : null;
  }
  if (change.table === 'task_requests') {
    const row = (await db.query('SELECT * FROM public.task_requests WHERE id = $1::uuid', [change.id])).rows[0];
    if (!row) return null;
    const approvers = await db.query('SELECT unnest(public.task_approver_ids($1::uuid)) AS user_id', [row.workspace_id]);
    return { row, audience: [...new Set([row.submitted_by, ...approvers.rows.map((r) => r.user_id)])] };
  }
  return null;
}

async function relay(payload: string | undefined): Promise<void> {
  let change: Change;
  try {
    change = JSON.parse(payload ?? '') as Change;
  } catch {
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(change.id ?? '')) return;
  const found = await load(change);
  if (found) publishDatabaseChange(change.table, change.event, found.row, found.audience);
}

async function connect(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return;
  const next = new pg.Client({ connectionString });
  next.on('notification', (message) => {
    if (message.channel !== 'app_changes') return;
    relay(message.payload).catch((err) => log.warn('change feed relay failed', { error: err instanceof Error ? err : String(err) }));
  });
  next.on('error', (err) => {
    log.warn('change feed connection lost', { error: err });
    if (client === next) client = null;
    next.end().catch(() => undefined);
    setTimeout(() => void ensureChangeFeed(), RECONNECT_MS).unref();
  });
  await next.connect();
  await next.query('LISTEN app_changes');
  client = next;
  log.info('change feed listening');
}

/** Starts listening once; safe to call on every new event stream. */
export async function ensureChangeFeed(): Promise<void> {
  if (client || starting) return;
  starting = true;
  try {
    await connect();
  } catch (err) {
    log.warn('change feed could not start', { error: err instanceof Error ? err : String(err) });
    setTimeout(() => void ensureChangeFeed(), RECONNECT_MS).unref();
  } finally {
    starting = false;
  }
}
