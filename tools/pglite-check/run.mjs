// Applies the local bootstrap and every migration to an in-memory PGlite
// (PostgreSQL compiled to WebAssembly, with pgvector) and runs behavioural
// checks of the 2026-10-19 migrations, including an upgrade of a workspace
// created on the previous schema. Needs no PostgreSQL installation.
//
//   npm run db:check
//
// PGlite is a different PostgreSQL major version than production and runs a
// single session; this validates SQL and behaviour, not the production image.
// The full suites run with `npm test` (local PostgreSQL) or deploy/test/run.sh.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import smoke, { pre } from './smoke.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const db = await PGlite.create({ extensions: { vector, pgcrypto, pg_trgm, uuid_ossp } });
console.log((await db.query('SELECT version()')).rows[0].version.split(' on ')[0]);

// The bootstrap emulates Supabase's roles, auth and storage schemas (psql meta-commands removed).
await db.exec(readFileSync(path.join(repo, 'tools/local-supabase/bootstrap.sql'), 'utf8').replace(/^\\set .*$/gm, ''));

const dir = path.join(repo, 'supabase/migrations');
let legacy = null;
for (const f of readdirSync(dir).filter((x) => /^\d{14}_.+\.sql$/.test(x)).sort()) {
  // An installation created before the provider/roster/automation migrations.
  if (!legacy && f.slice(0, 14) >= '20261019000000') legacy = await pre(db);
  // As in tools/local-supabase: pg_cron is stubbed by the bootstrap.
  const sql = readFileSync(path.join(dir, f), 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pg_cron;/g, '-- pg_cron stub');
  try {
    await db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    console.log(`FAIL ${f}: ${err.message}`);
    if (err.where) console.log(`  where: ${err.where}`);
    process.exit(1);
  }
  console.log(`ok   ${f}`);
}

await smoke(db, legacy);
