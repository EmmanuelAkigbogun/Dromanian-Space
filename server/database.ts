import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { dbError, HttpError, type DbError } from './http.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
const restUrl = process.env.DATABASE_REST_URL?.trim() ?? 'http://rest:3000';
const jwtSecret = process.env.APP_JWT_SECRET?.trim();

let poolValue: pg.Pool | null = null;

export function databasePool(): pg.Pool {
  if (!databaseUrl) throw new HttpError(503, 'not_configured', 'DATABASE_URL is not configured.');
  if (!poolValue) {
    poolValue = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      maxUses: 10_000,
    });
  }
  return poolValue;
}

export async function asAuthenticated<T>(user: AuthUser, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await databasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export interface AuthUser {
  id: string;
  email: string | null;
  appMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
}

export interface RequestAuth extends AuthUser {
  sessionId: string;
}

export function issueAccessToken(user: AuthUser, sessionId: string, lifetimeSeconds = 900): { token: string; expiresAt: number } {
  if (!jwtSecret) throw new HttpError(503, 'not_configured', 'APP_JWT_SECRET is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + lifetimeSeconds;
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated',
    session_id: sessionId,
    iat: now,
    exp: expiresAt,
  }));
  const input = `${header}.${payload}`;
  const signature = createHmac('sha256', jwtSecret).update(input).digest('base64url');
  return { token: `${input}.${signature}`, expiresAt };
}

function decodeAccessToken(token: string): RequestAuth | null {
  if (!jwtSecret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (claims.role !== 'authenticated' || typeof claims.sub !== 'string' || typeof claims.session_id !== 'string' || typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000) return null;
    return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : null, sessionId: claims.session_id };
  } catch { return null; }
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function authenticate(request: Request): Promise<RequestAuth> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  const decoded = bearer ? decodeAccessToken(bearer) : null;
  if (decoded) {
    const active = await databasePool().query(
      `SELECT u.raw_app_meta_data, u.raw_user_meta_data
         FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until < now())`,
      [decoded.sessionId, decoded.id],
    );
    if (active.rowCount) return { ...decoded, appMetadata: active.rows[0].raw_app_meta_data ?? {}, userMetadata: active.rows[0].raw_user_meta_data ?? {} };
  }

  const sessionToken = cookie(request, 'dromanian_session');
  if (!sessionToken) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
  const found = await databasePool().query(
    `SELECT s.id AS session_id, u.id, u.email, u.raw_app_meta_data, u.raw_user_meta_data
       FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until < now())`,
    [tokenHash(sessionToken)],
  );
  if (!found.rowCount) throw new HttpError(401, 'unauthenticated', 'Your session has expired. Sign in again.');
  const row = found.rows[0];
  return { id: row.id, email: row.email, sessionId: row.session_id, appMetadata: row.raw_app_meta_data ?? {}, userMetadata: row.raw_user_meta_data ?? {} };
}

type QueryResult<T = any> = { data: T | null; error: DbError | null; count?: number | null };
type QueryValue = string | number | boolean | null | readonly unknown[] | Record<string, unknown>;

function encodeValue(value: QueryValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `{${value.join(',')}}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

class RestQuery<T = any> implements PromiseLike<QueryResult<T>> {
  private method = 'GET';
  private body: unknown;
  private params = new URLSearchParams();
  private headers = new Headers();
  private maybe = false;
  private path: string;
  constructor(path: string) { this.path = path; }
  select(columns = '*', options?: { count?: string; head?: boolean }): this { this.params.set('select', columns); if (options?.head) this.method = 'HEAD'; if (options?.count) this.prefer(`count=${options.count}`); if (!['GET', 'HEAD'].includes(this.method)) this.prefer('return=representation'); return this; }
  insert(value: unknown, options?: { count?: string; defaultToNull?: boolean }): this { this.method = 'POST'; this.body = value; if (options?.count) this.prefer(`count=${options.count}`); if (options?.defaultToNull === false) this.prefer('missing=default'); return this; }
  upsert(value: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string }): this { this.method = 'POST'; this.body = value; this.prefer(`resolution=${options?.ignoreDuplicates ? 'ignore' : 'merge'}-duplicates`); if (options?.onConflict) this.params.set('on_conflict', options.onConflict); if (options?.count) this.prefer(`count=${options.count}`); return this; }
  update(value: unknown, options?: { count?: string }): this { this.method = 'PATCH'; this.body = value; if (options?.count) this.prefer(`count=${options.count}`); return this; }
  delete(options?: { count?: string }): this { this.method = 'DELETE'; if (options?.count) this.prefer(`count=${options.count}`); return this; }
  eq(c: string, v: QueryValue): this { return this.filter(c, 'eq', v); } neq(c: string, v: QueryValue): this { return this.filter(c, 'neq', v); }
  gt(c: string, v: QueryValue): this { return this.filter(c, 'gt', v); } gte(c: string, v: QueryValue): this { return this.filter(c, 'gte', v); }
  lt(c: string, v: QueryValue): this { return this.filter(c, 'lt', v); } lte(c: string, v: QueryValue): this { return this.filter(c, 'lte', v); }
  is(c: string, v: QueryValue): this { return this.filter(c, 'is', v); } like(c: string, v: string): this { return this.filter(c, 'like', v); } ilike(c: string, v: string): this { return this.filter(c, 'ilike', v); }
  contains(c: string, v: QueryValue): this { return this.filter(c, 'cs', v); } containedBy(c: string, v: QueryValue): this { return this.filter(c, 'cd', v); } overlaps(c: string, v: QueryValue): this { return this.filter(c, 'ov', v); }
  in(c: string, values: readonly unknown[]): this { this.params.append(c, `in.(${values.map((v) => `"${String(v).replaceAll('"', '\\"')}"`).join(',')})`); return this; }
  match(values: Record<string, QueryValue>): this { for (const [c, v] of Object.entries(values)) this.eq(c, v); return this; }
  filter(c: string, op: string, v: QueryValue): this { this.params.append(c, `${op}.${encodeValue(v)}`); return this; }
  not(c: string, op: string, v: QueryValue): this { this.params.append(c, `not.${op}.${encodeValue(v)}`); return this; }
  or(value: string): this { this.params.append('or', `(${value})`); return this; }
  order(c: string, o?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string }): this { this.params.append(o?.foreignTable ? `${o.foreignTable}.order` : 'order', `${c}.${o?.ascending === false ? 'desc' : 'asc'}`); return this; }
  limit(n: number): this { this.params.set('limit', String(n)); return this; }
  range(from: number, to: number): this { this.params.set('offset', String(from)); this.params.set('limit', String(to - from + 1)); return this; }
  single(): this { this.headers.set('accept', 'application/vnd.pgrst.object+json'); return this; }
  maybeSingle(): this { this.maybe = true; return this.single(); }
  returns<U>(): RestQuery<U> { return this as unknown as RestQuery<U>; }
  private prefer(value: string): void { const current = this.headers.get('prefer'); this.headers.set('prefer', current ? `${current},${value}` : value); }
  private async execute(): Promise<QueryResult<T>> {
    const query = this.params.toString();
    // Service jobs use a separately issued JWT whose role bypasses RLS.
    const serviceToken = issueRoleToken('service_role');
    this.headers.set('authorization', `Bearer ${serviceToken}`);
    if (this.body !== undefined) this.headers.set('content-type', 'application/json');
    const response = await fetch(`${restUrl}/${this.path}${query ? `?${query}` : ''}`, { method: this.method, headers: this.headers, body: this.body === undefined ? undefined : JSON.stringify(this.body), signal: AbortSignal.timeout(30_000) });
    const data = response.status === 204 || this.method === 'HEAD' ? null : await response.json().catch(() => null);
    if (!response.ok) { if (this.maybe && response.status === 406 && data?.code === 'PGRST116') return { data: null, error: null }; return { data: null, error: data ?? { message: `Database request failed (${response.status})` } }; }
    const range = response.headers.get('content-range');
    return { data: data as T, error: null, count: range?.includes('/') ? Number(range.split('/')[1]) : null };
  }
  then<A = QueryResult<T>, B = never>(ok?: ((v: QueryResult<T>) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> { return this.execute().then(ok, fail); }
}

function issueRoleToken(role: 'service_role' | 'authenticated', user?: AuthUser, sessionId?: string): string {
  if (!jwtSecret) throw new HttpError(503, 'not_configured', 'APP_JWT_SECRET is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const input = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: user?.id, email: user?.email, role, aud: 'authenticated', session_id: sessionId, iat: now, exp: now + 60 }))}`;
  return `${input}.${createHmac('sha256', jwtSecret).update(input).digest('base64url')}`;
}

function serviceStorage(bucket: string) {
  const root = path.resolve(process.env.STORAGE_ROOT?.trim() ?? '/data/storage');
  const resolveObject = (name: string) => {
    const value = path.resolve(root, bucket, ...name.split('/'));
    const base = path.resolve(root, bucket) + path.sep;
    if (!value.startsWith(base)) throw new Error('Invalid storage path.');
    return value;
  };
  return {
    async download(name: string): Promise<{ data: Blob | null; error: DbError | null }> {
      try {
        const object = await databasePool().query('SELECT metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, name]);
        if (!object.rowCount) return { data: null, error: { message: 'Object not found.', code: '404' } };
        const bytes = await readFile(resolveObject(name));
        return { data: new Blob([bytes], { type: object.rows[0].metadata?.mimetype ?? 'application/octet-stream' }), error: null };
      } catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }; }
    },
    async remove(names: string[]): Promise<{ data: Array<{ name: string }> | null; error: DbError | null }> {
      try {
        const removed = await databasePool().query('DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[]) RETURNING name', [bucket, names]);
        await Promise.all(removed.rows.map((row) => unlink(resolveObject(row.name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; })));
        return { data: removed.rows, error: null };
      } catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }; }
    },
  };
}

const service = {
  from<T = any>(table: string) { return new RestQuery<T>(encodeURIComponent(table)); },
  rpc<T = any>(fn: string, args: Record<string, unknown> = {}) { return new RestQuery<T>(`rpc/${encodeURIComponent(fn)}`).insert(args); },
  storage: { from: serviceStorage },
};

export function serviceClient(): any { return service; }

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await service.rpc<T>(fn, args);
  if (error) throw dbError(error, fn);
  return data as T;
}

export async function requireMember(workspaceId: string, userId: string): Promise<void> {
  const { data, error } = await service.from('workspace_members').select('user_id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  if (error) throw dbError(error, 'requireMember');
  if (!data) throw new HttpError(403, 'forbidden', 'You are not a member of this workspace.');
}

export function jwtForRequest(user: RequestAuth): string {
  return issueRoleToken('authenticated', user, user.sessionId);
}

