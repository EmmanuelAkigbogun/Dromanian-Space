/**
 * Database helpers for permission tests. Each helper runs SQL exactly the way
 * PostgREST does for a real request: inside a transaction, as the `anon`,
 * `authenticated` or `service_role` role, with `request.jwt.claims` set. Users
 * are real rows in auth.users, so every test uses genuinely different
 * identities and tenants.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DATABASE_URL } from '../../tools/local-supabase/lib.ts';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });

export interface TestUser {
  id: string;
  email: string;
}

type Role = 'anon' | 'authenticated' | 'service_role';

async function runAs<T>(
  role: Role,
  claims: Record<string, unknown>,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function asUser<T>(user: TestUser, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return runAs('authenticated', { sub: user.id, role: 'authenticated', email: user.email }, fn);
}

export function asAnon<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return runAs('anon', { role: 'anon' }, fn);
}

export function asService<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return runAs('service_role', { role: 'service_role' }, fn);
}

/** Runs a query as a user and returns rows (convenience). */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  user: TestUser,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asUser(user, async (c) => (await c.query<T>(sql, params)).rows);
}

/** Runs a query as the database owner (fixtures and assertions only). */
export async function admin<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}

export async function createUser(label = 'user'): Promise<TestUser> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
     VALUES ($1, $2, crypt('password123', gen_salt('bf')), now(), $3)`,
    [id, email, { full_name: label }],
  );
  return { id, email };
}

export async function createWorkspace(owner: TestUser, name = 'Workspace'): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`;
  const rows = await q<{ ws: { id: string } }>(owner, 'SELECT create_workspace_with_owner($1, $2, $3, NULL) AS ws', [
    name,
    slug,
    owner.id,
  ]);
  return rows[0].ws.id;
}

export async function addMember(workspaceId: string, user: TestUser, role: 'admin' | 'member' = 'member') {
  await admin('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
    workspaceId,
    user.id,
    role,
  ]);
}

export async function createChannel(
  creator: TestUser,
  workspaceId: string,
  options: { name?: string; isPrivate?: boolean; members?: TestUser[] } = {},
): Promise<string> {
  const name = options.name ?? `chan-${randomUUID().slice(0, 6)}`;
  return asUser(creator, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, name, slug, is_private, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [workspaceId, name, `${name}-${randomUUID().slice(0, 6)}`, options.isPrivate ?? false, creator.id],
    );
    const channelId = rows[0].id;
    await c.query(`INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      channelId,
      creator.id,
    ]);
    for (const member of options.members ?? []) {
      await c.query(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, [channelId, member.id]);
    }
    return channelId;
  });
}

export async function postMessage(user: TestUser, channelId: string, content: string, parentId?: string) {
  const rows = await q<{ id: string }>(
    user,
    'INSERT INTO messages (channel_id, user_id, content, parent_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [channelId, user.id, content, parentId ?? null],
  );
  return rows[0].id;
}

/** Inserts a storage object as if uploaded by `owner` through the Storage API. */
export async function putObject(bucket: string, name: string, owner: TestUser, mime = 'text/plain', size = 10) {
  await admin(
    `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
     VALUES ($1, $2, $3::uuid, $4::text, jsonb_build_object('size', $5::int, 'mimetype', $6::text))`,
    [bucket, name, owner.id, owner.id, size, mime],
  );
}

/** Expects the promise to fail with a permission/RLS error. */
export async function expectDenied(promise: Promise<unknown>, pattern = /permission|row-level security|not allowed|no permission|not authorized|denied|not a workspace member|need (edit|comment) access|cannot change sharing|not found/i) {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return message;
    throw new Error(`Expected a permission error but got: ${message}`);
  }
  throw new Error('Expected a permission error but the operation succeeded');
}
