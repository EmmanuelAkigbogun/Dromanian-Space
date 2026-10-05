/**
 * Local stand-in for the Supabase API gateway (development and tests only).
 *
 *   /rest/v1/*     -> PostgREST (real)
 *   /auth/v1/*     -> minimal GoTrue-compatible endpoints used by supabase-js
 *   /storage/v1/*  -> minimal Storage API; every object read/write runs as the
 *                     caller's database role with its JWT claims, so the
 *                     storage.objects RLS policies from the migrations decide
 *                     access exactly as hosted Supabase Storage does
 *   /realtime/v1/* -> not emulated (clients degrade to polling/refresh)
 */
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { importJWK, jwtVerify, type JWTPayload } from 'jose';
import {
  DATABASE_URL,
  GATEWAY_PORT,
  POSTGREST_PORT,
  STORAGE_DIR,
  loadOrCreateKeys,
  signJwt,
} from './lib.ts';

const ACCESS_TOKEN_TTL = 3600;
const keys = await loadOrCreateKeys();
const publicKey = await importJWK(keys.publicJwk, 'ES256');
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
const ISSUER = `http://localhost:${GATEWAY_PORT}/auth/v1`;

type Role = 'anon' | 'authenticated' | 'service_role';
interface Caller {
  role: Role;
  claims: Record<string, unknown>;
  userId: string | null;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.msg ?? status));
    this.status = status;
    this.body = body;
  }
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
  'access-control-allow-headers':
    'authorization,apikey,x-client-info,content-type,prefer,range,accept-profile,content-profile,x-upsert,cache-control,x-supabase-api-version,x-request-id',
  'access-control-expose-headers': 'content-range,content-length,x-supabase-api-version,location',
  'access-control-max-age': '86400',
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

async function verifyToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, publicKey, { algorithms: ['ES256'] });
  return payload;
}

async function resolveCaller(request: Request): Promise<Caller> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const apikey = request.headers.get('apikey') ?? '';
  const raw = token || apikey;
  if (!raw) return { role: 'anon', claims: { role: 'anon' }, userId: null };
  let payload: JWTPayload;
  try {
    payload = await verifyToken(raw);
  } catch {
    throw new HttpError(400, { statusCode: '403', error: 'Unauthorized', message: 'invalid JWT' });
  }
  const role = (payload.role as Role | undefined) ?? 'anon';
  if (!['anon', 'authenticated', 'service_role'].includes(role)) {
    throw new HttpError(400, { statusCode: '403', error: 'Unauthorized', message: 'invalid role' });
  }
  return { role, claims: payload as Record<string, unknown>, userId: (payload.sub as string | undefined) ?? null };
}

async function asCaller<T>(caller: Caller, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${caller.role}`);
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(caller.claims)]);
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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  raw_app_meta_data: Record<string, unknown>;
  raw_user_meta_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function userJson(u: UserRow) {
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.email_confirmed_at,
    confirmed_at: u.email_confirmed_at,
    phone: '',
    last_sign_in_at: u.last_sign_in_at,
    app_metadata: u.raw_app_meta_data ?? { provider: 'email', providers: ['email'] },
    user_metadata: u.raw_user_meta_data ?? {},
    identities: [],
    created_at: u.created_at,
    updated_at: u.updated_at,
    is_anonymous: false,
  };
}

async function issueSession(user: UserRow, sessionId?: string) {
  const sid = sessionId ?? randomUUID();
  if (!sessionId) {
    await pool.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [sid, user.id]);
  }
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signJwt(
    keys.privateJwk,
    {
      aud: 'authenticated',
      iss: ISSUER,
      sub: user.id,
      email: user.email,
      phone: '',
      app_metadata: user.raw_app_meta_data ?? {},
      user_metadata: user.raw_user_meta_data ?? {},
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: now }],
      session_id: sid,
      is_anonymous: false,
    },
    ACCESS_TOKEN_TTL,
  );
  const refreshToken = randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO auth.refresh_tokens (token, user_id, session_id) VALUES ($1, $2, $3)', [
    refreshToken,
    user.id,
    sid,
  ]);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL,
    expires_at: now + ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    user: userJson(user),
  };
}

const USER_COLUMNS =
  'id, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at';

async function createUser(email: string, password: string, metadata: Record<string, unknown>): Promise<UserRow> {
  const normalized = email.trim().toLowerCase();
  const existing = await pool.query('SELECT 1 FROM auth.users WHERE email = $1', [normalized]);
  if (existing.rowCount) {
    throw new HttpError(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
  }
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
     VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), $3)
     RETURNING ${USER_COLUMNS}`,
    [normalized, password, metadata],
  );
  return rows[0];
}

async function handleAuth(request: Request, subpath: string): Promise<Response> {
  const url = new URL(request.url);
  if (subpath === '/.well-known/jwks.json') return json(200, { keys: [keys.publicJwk] });
  if (subpath === '/settings') {
    return json(200, {
      external: { email: true, google: false, github: false },
      disable_signup: false,
      mailer_autoconfirm: true,
      phone_autoconfirm: false,
    });
  }
  if (subpath === '/health') return json(200, { name: 'GoTrue (local emulation)' });
  if (['/recover', '/otp', '/resend', '/magiclink'].includes(subpath)) return json(200, {});

  if (subpath === '/signup' && request.method === 'POST') {
    const body = (await request.json()) as { email?: string; password?: string; data?: Record<string, unknown> };
    if (!body.email || !body.password || body.password.length < 6) {
      throw new HttpError(422, { code: 422, error_code: 'validation_failed', msg: 'Email and a 6+ character password are required' });
    }
    const user = await createUser(body.email, body.password, body.data ?? {});
    return json(200, await issueSession(user));
  }

  if (subpath === '/token' && request.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    const body = (await request.json()) as { email?: string; password?: string; refresh_token?: string };
    if (grant === 'password') {
      const { rows } = await pool.query<UserRow>(
        `UPDATE auth.users SET last_sign_in_at = now()
         WHERE email = $1 AND encrypted_password = crypt($2, encrypted_password)
         RETURNING ${USER_COLUMNS}`,
        [String(body.email ?? '').trim().toLowerCase(), String(body.password ?? '')],
      );
      if (!rows[0]) {
        throw new HttpError(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      return json(200, await issueSession(rows[0]));
    }
    if (grant === 'refresh_token') {
      const { rows } = await pool.query<{ user_id: string; session_id: string }>(
        `UPDATE auth.refresh_tokens SET revoked = true
         WHERE token = $1 AND revoked = false RETURNING user_id, session_id`,
        [body.refresh_token ?? ''],
      );
      if (!rows[0]) {
        throw new HttpError(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      }
      const user = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM auth.users WHERE id = $1`, [rows[0].user_id]);
      return json(200, await issueSession(user.rows[0], rows[0].session_id));
    }
    throw new HttpError(400, { code: 400, error_code: 'unsupported_grant_type', msg: `Unsupported grant ${grant}` });
  }

  const caller = await resolveCaller(request);

  if (subpath === '/admin/users' && request.method === 'POST') {
    if (caller.role !== 'service_role') throw new HttpError(403, { msg: 'User not allowed' });
    const body = (await request.json()) as { email: string; password: string; user_metadata?: Record<string, unknown> };
    const user = await createUser(body.email, body.password, body.user_metadata ?? {});
    return json(200, userJson(user));
  }

  if (!caller.userId || caller.role !== 'authenticated') {
    throw new HttpError(401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a valid Bearer token' });
  }

  if (subpath === '/logout') {
    await pool.query('UPDATE auth.refresh_tokens SET revoked = true WHERE session_id = $1', [
      caller.claims.session_id ?? null,
    ]);
    return new Response(null, { status: 204 });
  }

  if (subpath === '/user' && request.method === 'GET') {
    const { rows } = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM auth.users WHERE id = $1`, [caller.userId]);
    if (!rows[0]) throw new HttpError(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
    return json(200, userJson(rows[0]));
  }

  if (subpath === '/user' && request.method === 'PUT') {
    const body = (await request.json()) as { data?: Record<string, unknown>; password?: string; email?: string };
    const { rows } = await pool.query<UserRow>(
      `UPDATE auth.users SET
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || coalesce($2::jsonb, '{}'::jsonb),
         encrypted_password = CASE WHEN $3::text IS NULL THEN encrypted_password ELSE crypt($3, gen_salt('bf')) END,
         email = coalesce(lower($4), email),
         updated_at = now()
       WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [caller.userId, body.data ?? null, body.password ?? null, body.email ?? null],
    );
    return json(200, userJson(rows[0]));
  }

  throw new HttpError(404, { code: 404, msg: `Auth endpoint ${request.method} ${subpath} is not emulated` });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface BucketRow {
  id: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

function safeObjectPath(bucket: string, name: string): string {
  const resolved = path.resolve(STORAGE_DIR, bucket, name);
  const root = path.resolve(STORAGE_DIR, bucket) + path.sep;
  if (!resolved.startsWith(root)) throw new HttpError(400, { statusCode: '400', error: 'InvalidKey', message: 'Invalid key' });
  return resolved;
}

function storageError(status: number, error: string, message: string): HttpError {
  return new HttpError(status, { statusCode: String(status), error, message });
}

function rlsError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  if (/row-level security|permission denied/i.test(message)) {
    return storageError(403, 'Unauthorized', 'new row violates row-level security policy');
  }
  return storageError(400, 'DatabaseError', message);
}

async function getBucket(bucketId: string): Promise<BucketRow> {
  const { rows } = await pool.query<BucketRow>(
    'SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = $1',
    [bucketId],
  );
  if (!rows[0]) throw storageError(404, 'Bucket not found', 'Bucket not found');
  return rows[0];
}

function mimeAllowed(bucket: BucketRow, mime: string): boolean {
  if (!bucket.allowed_mime_types || bucket.allowed_mime_types.length === 0) return true;
  return bucket.allowed_mime_types.some((pattern) =>
    pattern.endsWith('/*') ? mime.startsWith(pattern.slice(0, -1)) : pattern === mime,
  );
}

async function readUploadBody(request: Request): Promise<{ bytes: Buffer; mime: string; cacheControl: string }> {
  const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData();
    let file: File | null = null;
    for (const [, value] of form.entries()) {
      if (typeof value !== 'string') file = value as File;
    }
    if (!file) throw storageError(400, 'InvalidRequest', 'No file in form data');
    return {
      bytes: Buffer.from(await file.arrayBuffer()),
      mime: file.type || 'application/octet-stream',
      cacheControl: String(form.get('cacheControl') ?? '3600'),
    };
  }
  return {
    bytes: Buffer.from(await request.arrayBuffer()),
    mime: contentType,
    cacheControl: request.headers.get('cache-control') ?? '3600',
  };
}

async function storeObject(
  caller: Caller,
  bucketId: string,
  name: string,
  upload: { bytes: Buffer; mime: string; cacheControl: string },
  upsert: boolean,
): Promise<Response> {
  const bucket = await getBucket(bucketId);
  if (bucket.file_size_limit && upload.bytes.length > bucket.file_size_limit) {
    throw storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size');
  }
  if (!mimeAllowed(bucket, upload.mime)) {
    throw storageError(415, 'invalid_mime_type', `mime type ${upload.mime} is not supported`);
  }
  const etag = createHash('md5').update(upload.bytes).digest('hex');
  const metadata = {
    eTag: `"${etag}"`,
    size: upload.bytes.length,
    mimetype: upload.mime,
    cacheControl: `max-age=${upload.cacheControl}`,
    lastModified: new Date().toISOString(),
    contentLength: upload.bytes.length,
    httpStatusCode: 200,
  };
  const id = await asCaller(caller, async (client) => {
    try {
      const sql = upsert
        ? `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (bucket_id, name) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = now()
           RETURNING id`
        : `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`;
      const { rows } = await client.query<{ id: string }>(sql, [
        bucketId,
        name,
        caller.userId,
        caller.userId,
        metadata,
      ]);
      return rows[0].id;
    } catch (error) {
      if (error instanceof Error && /duplicate key/i.test(error.message)) {
        throw storageError(409, 'Duplicate', 'The resource already exists');
      }
      throw rlsError(error);
    }
  });
  const file = safeObjectPath(bucketId, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, upload.bytes);
  return json(200, { Id: id, id, Key: `${bucketId}/${name}`, path: name, fullPath: `${bucketId}/${name}` });
}

async function canSelect(caller: Caller, bucketId: string, name: string) {
  return asCaller(caller, async (client) => {
    const { rows } = await client.query<{ id: string; metadata: Record<string, unknown> }>(
      'SELECT id, metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2',
      [bucketId, name],
    );
    return rows[0] ?? null;
  });
}

function serveFile(bucketId: string, name: string, mime: string, download: string | null): Response {
  const file = safeObjectPath(bucketId, name);
  if (!existsSync(file)) throw storageError(404, 'not_found', 'Object not found');
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  const headers: Record<string, string> = {
    'content-type': mime || 'application/octet-stream',
    'content-length': String(statSync(file).size),
    'cache-control': 'private, max-age=0',
  };
  if (download !== null) {
    headers['content-disposition'] = `attachment; filename="${download || path.basename(name)}"`;
  }
  return new Response(stream, { status: 200, headers });
}

async function signUrl(bucketId: string, name: string, expiresIn: number): Promise<string> {
  const token = await signJwt(keys.privateJwk, { url: `${bucketId}/${name}` }, Math.max(1, Math.min(expiresIn, 604800)));
  return `/object/sign/${bucketId}/${encodeURI(name)}?token=${token}`;
}

async function handleStorage(request: Request, subpath: string): Promise<Response> {
  const url = new URL(request.url);
  const segments = subpath.split('/').filter(Boolean).map(decodeURIComponent);

  // Signed download: GET /object/sign/:bucket/*name?token=
  if (segments[0] === 'object' && segments[1] === 'sign' && request.method === 'GET') {
    const bucketId = segments[2];
    const name = segments.slice(3).join('/');
    const token = url.searchParams.get('token') ?? '';
    let payload: JWTPayload;
    try {
      payload = await verifyToken(token);
    } catch {
      throw storageError(400, 'InvalidJWT', 'invalid signature or expired token');
    }
    if (payload.url !== `${bucketId}/${name}`) throw storageError(400, 'InvalidSignature', 'The url does not match');
    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2',
      [bucketId, name],
    );
    if (!rows[0]) throw storageError(404, 'not_found', 'Object not found');
    return serveFile(bucketId, name, String(rows[0].metadata?.mimetype ?? ''), url.searchParams.get('download'));
  }

  // Public bucket read: GET /object/public/:bucket/*name
  if (segments[0] === 'object' && segments[1] === 'public' && request.method === 'GET') {
    const bucket = await getBucket(segments[2]);
    if (!bucket.public) throw storageError(400, 'not_found', 'Object not found');
    const name = segments.slice(3).join('/');
    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2',
      [bucket.id, name],
    );
    if (!rows[0]) throw storageError(404, 'not_found', 'Object not found');
    return serveFile(bucket.id, name, String(rows[0].metadata?.mimetype ?? ''), url.searchParams.get('download'));
  }

  const caller = await resolveCaller(request);

  // Create signed URL(s)
  if (segments[0] === 'object' && segments[1] === 'sign' && request.method === 'POST') {
    const bucketId = segments[2];
    const body = (await request.json()) as { expiresIn?: number; paths?: string[] };
    const expiresIn = Number(body.expiresIn ?? 60);
    if (segments.length > 3) {
      const name = segments.slice(3).join('/');
      const row = await canSelect(caller, bucketId, name);
      if (!row) throw storageError(400, 'not_found', 'Object not found');
      return json(200, { signedURL: await signUrl(bucketId, name, expiresIn) });
    }
    const results = [];
    for (const name of body.paths ?? []) {
      const row = await canSelect(caller, bucketId, name);
      results.push(
        row
          ? { error: null, path: name, signedURL: await signUrl(bucketId, name, expiresIn) }
          : { error: 'Either the object does not exist or you do not have access to it', path: name, signedURL: null },
      );
    }
    return json(200, results);
  }

  // List objects
  if (segments[0] === 'object' && segments[1] === 'list' && request.method === 'POST') {
    const bucketId = segments[2];
    const body = (await request.json()) as { prefix?: string; limit?: number; offset?: number };
    const prefix = (body.prefix ?? '').replace(/^\/+/, '');
    const rows = await asCaller(caller, async (client) => {
      const result = await client.query<{ id: string; name: string; metadata: unknown; created_at: string; updated_at: string }>(
        `SELECT id, name, metadata, created_at, updated_at FROM storage.objects
         WHERE bucket_id = $1 AND name LIKE $2 ORDER BY name LIMIT $3 OFFSET $4`,
        [bucketId, `${prefix}${prefix && !prefix.endsWith('/') ? '/' : ''}%`, body.limit ?? 100, body.offset ?? 0],
      );
      return result.rows;
    });
    return json(
      200,
      rows.map((r) => ({ ...r, name: r.name.slice(prefix ? prefix.replace(/\/?$/, '/').length : 0) })),
    );
  }

  // Remove objects: DELETE /object/:bucket {prefixes}
  if (segments[0] === 'object' && request.method === 'DELETE' && segments.length === 2) {
    const bucketId = segments[1];
    const body = (await request.json()) as { prefixes?: string[] };
    const deleted = await asCaller(caller, async (client) => {
      const result = await client.query<{ name: string; id: string }>(
        'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[]) RETURNING id, name',
        [bucketId, body.prefixes ?? []],
      );
      return result.rows;
    });
    for (const row of deleted) {
      rmSync(safeObjectPath(bucketId, row.name), { force: true });
    }
    return json(200, deleted.map((r) => ({ bucket_id: bucketId, name: r.name, id: r.id })));
  }

  // Authenticated download: GET /object/authenticated/:bucket/*name or /object/:bucket/*name
  if (segments[0] === 'object' && request.method === 'GET') {
    const offset = segments[1] === 'authenticated' ? 2 : 1;
    const bucketId = segments[offset];
    const name = segments.slice(offset + 1).join('/');
    const row = await canSelect(caller, bucketId, name);
    if (!row) throw storageError(400, 'not_found', 'Object not found');
    return serveFile(bucketId, name, String(row.metadata?.mimetype ?? ''), url.searchParams.get('download'));
  }

  // Upload: POST (create) / PUT (update) /object/:bucket/*name
  if (segments[0] === 'object' && (request.method === 'POST' || request.method === 'PUT')) {
    const bucketId = segments[1];
    const name = segments.slice(2).join('/');
    if (!name) throw storageError(400, 'InvalidKey', 'Missing object name');
    const upsert = request.method === 'PUT' || request.headers.get('x-upsert') === 'true';
    const upload = await readUploadBody(request);
    return storeObject(caller, bucketId, name, upload, upsert);
  }

  throw storageError(404, 'not_found', `Storage endpoint ${request.method} ${subpath} is not emulated`);
}

// ---------------------------------------------------------------------------
// PostgREST proxy and HTTP server
// ---------------------------------------------------------------------------

async function proxyRest(request: Request, subpath: string): Promise<Response> {
  const url = new URL(request.url);
  const target = `http://localhost:${POSTGREST_PORT}${subpath}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  if (!headers.get('authorization') && headers.get('apikey')) {
    headers.set('authorization', `Bearer ${headers.get('apikey')}`);
  }
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, { method: request.method, headers, body });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  responseHeaders.delete('transfer-encoding');
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function route(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (pathname.startsWith('/rest/v1')) return proxyRest(request, pathname.slice('/rest/v1'.length) || '/');
  if (pathname.startsWith('/auth/v1')) return handleAuth(request, pathname.slice('/auth/v1'.length));
  if (pathname.startsWith('/storage/v1')) return handleStorage(request, pathname.slice('/storage/v1'.length));
  if (pathname === '/health') return json(200, { ok: true });
  return json(404, { message: `No local emulation for ${pathname}` });
}

function toRequest(req: http.IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  return new Request(`http://localhost:${GATEWAY_PORT}${req.url ?? '/'}`, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : new Uint8Array(body),
  });
}

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    let response: Response;
    try {
      response = await route(toRequest(req, Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof HttpError) {
        response = json(error.status, error.body);
      } else {
        console.error('[gateway]', error);
        response = json(500, { message: error instanceof Error ? error.message : 'Internal error' });
      }
    }
    const headers: Record<string, string> = { ...CORS_HEADERS };
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  });
});

server.on('upgrade', (_req, socket) => {
  // Realtime is not emulated; refuse the websocket so clients fall back.
  socket.destroy();
});

if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });
server.listen(GATEWAY_PORT, () => {
  console.log(`[gateway] listening on http://localhost:${GATEWAY_PORT}`);
});
