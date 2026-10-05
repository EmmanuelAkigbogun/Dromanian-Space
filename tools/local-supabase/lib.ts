/**
 * Shared helpers for the local Supabase emulation used in development and tests.
 * Nothing here is deployed; it exists so that RLS, Storage policies, RPCs and the
 * /api handlers can be exercised against a real PostgreSQL 17 + PostgREST stack
 * without Docker.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '../..');
export const STATE_DIR = path.join(REPO_ROOT, '.local', 'supabase');
export const PGDATA = path.join(STATE_DIR, 'pgdata');
export const STORAGE_DIR = path.join(STATE_DIR, 'storage');
export const LOG_DIR = path.join(STATE_DIR, 'logs');
export const KEYS_FILE = path.join(STATE_DIR, 'keys.json');
export const JWKS_FILE = path.join(STATE_DIR, 'jwks.json');
export const POSTGREST_CONF = path.join(STATE_DIR, 'postgrest.conf');
export const PIDS_FILE = path.join(STATE_DIR, 'pids.json');
export const ENV_FILE = path.join(STATE_DIR, 'env');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
export const BOOTSTRAP_SQL = path.join(here, 'bootstrap.sql');

export const PG_BIN = process.env.LOCAL_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
export const POSTGREST_BIN = process.env.LOCAL_POSTGREST_BIN ?? '/opt/homebrew/bin/postgrest';

export const PG_PORT = Number(process.env.LOCAL_PG_PORT ?? 55432);
export const POSTGREST_PORT = Number(process.env.LOCAL_POSTGREST_PORT ?? 55320);
export const GATEWAY_PORT = Number(process.env.LOCAL_GATEWAY_PORT ?? 55321);
export const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`;
export const DATABASE_URL = `postgres://postgres@localhost:${PG_PORT}/postgres`;

export interface LocalKeys {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  anonKey: string;
  serviceKey: string;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function loadOrCreateKeys(): Promise<LocalKeys> {
  ensureDir(STATE_DIR);
  if (existsSync(KEYS_FILE)) {
    return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as LocalKeys;
  }
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `local-${Date.now().toString(36)}`;
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'ES256', use: 'sig' };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const tenYears = 60 * 60 * 24 * 365 * 10;
  const anonKey = await signJwt(privateJwk, { role: 'anon', iss: 'supabase-local' }, tenYears);
  const serviceKey = await signJwt(privateJwk, { role: 'service_role', iss: 'supabase-local' }, tenYears);
  const keys: LocalKeys = { kid, privateJwk, publicJwk, anonKey, serviceKey };
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  writeFileSync(JWKS_FILE, JSON.stringify({ keys: [publicJwk] }));
  return keys;
}

export async function signJwt(
  privateJwk: JWK,
  claims: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const key = await importJWK(privateJwk, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: privateJwk.kid, typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

export function psql(args: string[], options: { input?: string; database?: string } = {}) {
  const result = spawnSync(
    path.join(PG_BIN, 'psql'),
    [
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      'localhost',
      '-p',
      String(PG_PORT),
      '-U',
      'postgres',
      '-d',
      options.database ?? 'postgres',
      ...args,
    ],
    { input: options.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed (${args.join(' ')}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Hosted Supabase ships pg_cron; this machine does not. The bootstrap provides
 * a stand-in `cron` schema, so the legacy baseline only needs its
 * `CREATE EXTENSION pg_cron` statements neutralised. The SQL is otherwise
 * applied exactly as written.
 */
export function adaptSqlForLocal(sql: string): string {
  return sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron;/g, '-- (local) pg_cron provided by bootstrap stub');
}

export function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort();
}

export function applySqlFile(file: string, database = 'postgres'): void {
  const sql = adaptSqlForLocal(readFileSync(file, 'utf8'));
  psql(['--single-transaction', '-f', '-'], { input: sql, database });
}

/**
 * Applies every migration not yet recorded, like `supabase db push`. The
 * bootstrap (roles, auth/storage schemas, Supabase default grants) runs only
 * once per database, exactly like a freshly provisioned hosted project; running
 * it again would re-grant privileges that migrations deliberately revoke.
 */
export function applyMigrations(database = 'postgres', options: { upTo?: string } = {}): string[] {
  const initialized =
    psql(['-A', '-t', '-c', "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL"], {
      database,
    }).trim() === 't';
  if (!initialized) psql(['-f', BOOTSTRAP_SQL], { database });
  psql(
    [
      '-c',
      `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
       CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
         version text PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());`,
    ],
    { database },
  );
  const applied = new Set(
    psql(['-A', '-t', '-c', 'SELECT version FROM supabase_migrations.schema_migrations'], { database })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const newlyApplied: string[] = [];
  for (const file of listMigrations()) {
    const version = file.slice(0, 14);
    if (options.upTo && version > options.upTo) break;
    if (applied.has(version)) continue;
    applySqlFile(path.join(MIGRATIONS_DIR, file), database);
    psql(
      ['-c', `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${version}', '${file}')`],
      { database },
    );
    newlyApplied.push(file);
  }
  return newlyApplied;
}
