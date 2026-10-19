import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authenticate, databasePool, issueAccessToken, tokenHash, type AuthUser, type RequestAuth } from '../server/database.js';
import { HttpError, json, readJson } from '../server/http.js';

const scrypt = promisify(scryptCallback);
const credentials = z.object({ email: z.string().trim().email().max(255), password: z.string().min(8).max(1024) });
const userUpdate = z.object({ password: z.string().min(8).max(1024).optional(), data: z.record(z.string(), z.unknown()).optional() });
const recovery = z.object({ access_token: z.string().min(20), refresh_token: z.string().optional() });
const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? 30);
const FIRST_ADMIN_EMAIL = 'samuel.buzatu@digitalromanian.com';

function toUser(user: AuthUser & { createdAt?: string }) {
  return {
    id: user.id,
    email: user.email,
    app_metadata: user.appMetadata ?? { provider: 'email', providers: ['email'] },
    user_metadata: user.userMetadata ?? {},
    created_at: user.createdAt,
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded?.startsWith('scrypt$')) return false;
  const [, saltValue, hashValue] = encoded.split('$');
  if (!saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function createSession(user: AuthUser, request: Request) {
  const token = randomBytes(32).toString('base64url');
  const expiresAtDate = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const inserted = await databasePool().query(
    `INSERT INTO auth.sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [user.id, tokenHash(token), expiresAtDate, request.headers.get('user-agent')?.slice(0, 500) ?? null],
  );
  const { token: accessToken, expiresAt } = issueAccessToken(user, inserted.rows[0].id);
  return {
    rawToken: token,
    session: {
      access_token: accessToken,
      expires_at: expiresAt,
      expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
      token_type: 'bearer' as const,
      user: toUser(user),
    },
  };
}

function sessionCookie(token: string, expires?: Date): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `dromanian_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}${expires ? `; Expires=${expires.toUTCString()}` : ''}`;
}

export async function signup(request: Request): Promise<Response> {
  const body = await readJson(request, credentials.extend({ options: z.unknown().optional() }));
  const email = body.email.toLowerCase();
  if (!/^[^\s@]+@digitalromanian[.]com$/i.test(email)) {
    throw new HttpError(403, 'email_domain_not_allowed', 'Use your @digitalromanian.com email address.');
  }
  const encrypted = await hashPassword(body.password);
  const client = await databasePool().connect();
  try {
    await client.query('BEGIN');
    // Serialize initial registration so two simultaneous requests cannot both
    // believe they are creating the first account.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('dromanian:first-user'))`);
    const users = await client.query('SELECT count(*)::integer AS count FROM auth.users WHERE deleted_at IS NULL');
    const isFirstUser = users.rows[0].count === 0;
    if (isFirstUser && email !== FIRST_ADMIN_EMAIL) {
      throw new HttpError(403, 'first_admin_required', `The first account must be ${FIRST_ADMIN_EMAIL}.`);
    }
    const appMetadata = {
      provider: 'email',
      providers: ['email'],
      role: isFirstUser ? 'owner' : 'member',
      platform_admin: isFirstUser,
    };
    const inserted = await client.query(
      `INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       VALUES (gen_random_uuid(), 'authenticated', 'authenticated', $1, $2, now(), $3::jsonb, '{}', now(), now())
       RETURNING id, email, raw_app_meta_data, raw_user_meta_data, created_at`,
      [email, encrypted, JSON.stringify(appMetadata)],
    );
    const row = inserted.rows[0];
    await client.query(
      `INSERT INTO auth.identities (user_id, provider, identity_data)
       VALUES ($1, 'email', jsonb_build_object('sub', $1::text, 'email', $2))`,
      [row.id, row.email],
    );
    await client.query('COMMIT');
    const user: AuthUser = { id: row.id, email: row.email, appMetadata: row.raw_app_meta_data, userMetadata: row.raw_user_meta_data };
    const created = await createSession(user, request);
    return json({ user: toUser({ ...user, createdAt: row.created_at }), session: created.session }, 201, { 'set-cookie': sessionCookie(created.rawToken, new Date(Date.now() + SESSION_DAYS * 86_400_000)) });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') throw new HttpError(409, 'user_already_exists', 'An account already exists for this email address.');
    throw error;
  } finally { client.release(); }
}

export async function signin(request: Request): Promise<Response> {
  const body = await readJson(request, credentials);
  const found = await databasePool().query(
    `SELECT id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at
       FROM auth.users WHERE lower(email) = lower($1) AND deleted_at IS NULL
        AND (banned_until IS NULL OR banned_until < now())`,
    [body.email],
  );
  const row = found.rows[0];
  if (!row || !await verifyPassword(body.password, row.encrypted_password)) {
    throw new HttpError(400, 'invalid_credentials', 'Invalid email or password.');
  }
  const user: AuthUser = { id: row.id, email: row.email, appMetadata: row.raw_app_meta_data, userMetadata: row.raw_user_meta_data };
  const created = await createSession(user, request);
  await databasePool().query('UPDATE auth.users SET last_sign_in_at = now(), updated_at = now() WHERE id = $1', [user.id]);
  return json({ session: created.session }, 200, { 'set-cookie': sessionCookie(created.rawToken, new Date(Date.now() + SESSION_DAYS * 86_400_000)) });
}

export async function session(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const { token, expiresAt } = issueAccessToken(user, user.sessionId);
    return json({ session: { access_token: token, expires_at: expiresAt, expires_in: expiresAt - Math.floor(Date.now() / 1000), token_type: 'bearer', user: toUser(user) } });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return json({ session: null });
    throw error;
  }
}

export async function signout(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    await databasePool().query('UPDATE auth.sessions SET revoked_at = now() WHERE id = $1', [user.sessionId]);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 401)) throw error;
  }
  return json({}, 200, { 'set-cookie': sessionCookie('', new Date(0)) });
}

export async function updateUser(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  const body = await readJson(request, userUpdate);
  if (!body.password && !body.data) throw new HttpError(400, 'invalid_request', 'Nothing to update.');
  const encrypted = body.password ? await hashPassword(body.password) : null;
  const updated = await databasePool().query(
    `UPDATE auth.users SET
       encrypted_password = coalesce($2, encrypted_password),
       raw_user_meta_data = CASE WHEN $3::jsonb IS NULL THEN raw_user_meta_data ELSE raw_user_meta_data || $3::jsonb END,
       updated_at = now()
     WHERE id = $1 RETURNING id, email, raw_app_meta_data, raw_user_meta_data`,
    [auth.id, encrypted, body.data ? JSON.stringify(body.data) : null],
  );
  const row = updated.rows[0];
  const user: RequestAuth = { ...auth, email: row.email, appMetadata: row.raw_app_meta_data, userMetadata: row.raw_user_meta_data };
  const { token, expiresAt } = issueAccessToken(user, user.sessionId);
  return json({ user: toUser(user), session: { access_token: token, expires_at: expiresAt, expires_in: expiresAt - Math.floor(Date.now() / 1000), token_type: 'bearer', user: toUser(user) } });
}

export async function forgotPassword(request: Request): Promise<Response> {
  const { email } = await readJson(request, z.object({ email: z.string().email(), redirectTo: z.string().optional() }));
  const found = await databasePool().query('SELECT id FROM auth.users WHERE lower(email) = lower($1) AND deleted_at IS NULL', [email]);
  if (found.rowCount) {
    const token = randomBytes(32).toString('base64url');
    await databasePool().query(
      `INSERT INTO auth.password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [found.rows[0].id, tokenHash(token)],
    );
    // SMTP delivery is intentionally handled by the server operator. Never
    // reveal whether an address exists in this endpoint's response.
    console.info('password recovery token created', { email, token: process.env.NODE_ENV === 'production' ? '[redacted]' : token });
  }
  return json({});
}

export async function recover(request: Request): Promise<Response> {
  const body = await readJson(request, recovery);
  const client = await databasePool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `UPDATE auth.password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [tokenHash(body.access_token)],
    );
    if (!found.rowCount) throw new HttpError(400, 'invalid_recovery_token', 'This recovery link is invalid or expired.');
    const userRow = await client.query('SELECT id, email, raw_app_meta_data, raw_user_meta_data FROM auth.users WHERE id = $1', [found.rows[0].user_id]);
    await client.query('COMMIT');
    const row = userRow.rows[0];
    const user: AuthUser = { id: row.id, email: row.email, appMetadata: row.raw_app_meta_data, userMetadata: row.raw_user_meta_data };
    const created = await createSession(user, request);
    return json({ session: created.session }, 200, { 'set-cookie': sessionCookie(created.rawToken, new Date(Date.now() + SESSION_DAYS * 86_400_000)) });
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

