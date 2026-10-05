/**
 * Migration safety: the frozen legacy baseline, the guard that prevents
 * replaying it, clean provisioning, and an upgrade from a representative legacy
 * fixture (channel, private channel, DM, forwarded, link, missing-object and
 * browser-local attachments) that must keep every attachment visible to exactly
 * the same people. Each scenario runs in its own throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS_DIR, PG_PORT, REPO_ROOT, applySqlFile } from '../../tools/local-supabase/lib.ts';
import { pool as mainPool } from '../helpers/db.ts';

const created: string[] = [];

async function createDatabase(prefix: string): Promise<{ name: string; pool: pg.Pool }> {
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  await mainPool.query(`CREATE DATABASE ${name}`);
  created.push(name);
  return { name, pool: new pg.Pool({ connectionString: `postgres://postgres@localhost:${PG_PORT}/${name}`, max: 4 }) };
}

afterAll(async () => {
  for (const name of created) {
    await mainPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
});

async function as<T>(dbPool: pg.Pool, userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await dbPool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
    const { rows } = await c.query(sql, params);
    await c.query('COMMIT');
    return rows as T[];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('legacy baseline', () => {
  it('is a byte-identical copy of supabase/SQL/all/all.sql below its guard', () => {
    const legacy = readFileSync(path.join(REPO_ROOT, 'supabase', 'SQL', 'all', 'all.sql'), 'utf8');
    const baseline = readFileSync(path.join(MIGRATIONS_DIR, '20261004000000_legacy_baseline.sql'), 'utf8');
    expect(baseline.endsWith(legacy)).toBe(true);
    expect(baseline.length - legacy.length).toBeLessThan(3000);
  });
});

describe('clean provisioning', () => {
  let db: { name: string; pool: pg.Pool };
  beforeAll(async () => {
    db = await createDatabase('mig_clean');
    applyMigrations(db.name);
  }, 300_000);
  afterAll(async () => db.pool.end());

  it('creates the full schema and refuses to replay the legacy baseline', async () => {
    const { rows } = await db.pool.query(`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('workspaces','messages','drive_items','drive_versions','drive_grants','jobs','thread_follows')`);
    expect(rows[0].n).toBe(7);
    expect(() => applySqlFile(path.join(MIGRATIONS_DIR, '20261004000000_legacy_baseline.sql'), db.name))
      .toThrow(/Legacy baseline already present/);
    // The guard aborted before anything ran: automation tables still exist.
    const automation = await db.pool.query(`SELECT to_regclass('public.automation_rules') IS NOT NULL AS ok`);
    expect(automation.rows[0].ok).toBe(true);
  });
});

describe('upgrade from a legacy database', () => {
  let db: { name: string; pool: pg.Pool };
  const ids = {
    owner: randomUUID(), member: randomUUID(), secretMember: randomUUID(), outsider: randomUUID(),
    ws: randomUUID(), otherWs: randomUUID(), general: randomUUID(), secret: randomUUID(), dmChannel: randomUUID(), dm: randomUUID(),
  };
  const attachments: Record<string, string> = {};

  beforeAll(async () => {
    db = await createDatabase('mig_upgrade');
    applyMigrations(db.name, { upTo: '20261004000000' });
    const sql = (text: string, params: unknown[] = []) => db.pool.query(text, params);

    for (const [key, email] of [
      ['owner', 'owner@legacy.test'], ['member', 'member@legacy.test'], ['secretMember', 'secret@legacy.test'], ['outsider', 'out@legacy.test'],
    ] as const) {
      await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [ids[key], email]);
    }
    await sql(`INSERT INTO workspaces (id, name, slug, owner_id) VALUES ($1, 'Legacy', 'legacy', $2), ($3, 'Other', 'other', $4)`,
      [ids.ws, ids.owner, ids.otherWs, ids.outsider]);
    await sql(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner'), ($1,$3,'member'), ($1,$4,'member'), ($5,$6,'owner')`,
      [ids.ws, ids.owner, ids.member, ids.secretMember, ids.otherWs, ids.outsider]);
    await sql(`INSERT INTO channels (id, workspace_id, name, slug, is_private, created_by) VALUES
      ($1, $4, 'general', 'general', false, $5), ($2, $4, 'secret', 'secret', true, $5), ($3, $4, 'Direct Message', 'dm-legacy', true, $5)`,
      [ids.general, ids.secret, ids.dmChannel, ids.ws, ids.owner]);
    await sql(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1,$4), ($1,$5), ($2,$4), ($2,$6), ($3,$4), ($3,$5)`,
      [ids.general, ids.secret, ids.dmChannel, ids.owner, ids.member, ids.secretMember]);
    await sql(`INSERT INTO direct_conversations (id, workspace_id, channel_id, type, created_by) VALUES ($1, $2, $3, 'dm', $4)`,
      [ids.dm, ids.ws, ids.dmChannel, ids.owner]);
    await sql(`INSERT INTO direct_conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, [ids.dm, ids.owner, ids.member]);

    const object = (name: string, owner: string) =>
      sql(`INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata) VALUES ('message-attachments', $1, $2::uuid, $3::text, '{"size": 10, "mimetype": "application/pdf"}')`, [name, owner, owner]);
    const message = async (channel: string, user: string, content: string) =>
      (await sql(`INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3) RETURNING id`, [channel, user, content])).rows[0].id as string;
    const attach = async (key: string, msg: string, user: string, url: string, type = 'application/pdf') => {
      attachments[key] = (await sql(`INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
        VALUES ($1, $2, $3, 10, $4, $5) RETURNING id`, [msg, user, `${key}.pdf`, type, url])).rows[0].id;
    };

    await object(`${ids.general}/a.pdf`, ids.owner);
    await object(`${ids.secret}/b.pdf`, ids.owner);
    await object(`${ids.dmChannel}/c.pdf`, ids.member);
    await object(`${ids.general}/h.pdf`, ids.owner);
    await attach('general', await message(ids.general, ids.owner, 'roadmap'), ids.owner, `${ids.general}/a.pdf`);
    await attach('secret', await message(ids.secret, ids.owner, 'budget'), ids.owner, `${ids.secret}/b.pdf`);
    await attach('dm', await message(ids.dmChannel, ids.member, 'private photo'), ids.member, `${ids.dmChannel}/c.pdf`);
    await attach('forward', await message(ids.dmChannel, ids.member, 'fwd'), ids.member, `${ids.general}/a.pdf`);
    await attach('link', await message(ids.general, ids.owner, 'https://example.com'), ids.owner, 'https://example.com', 'application/x-link');
    await attach('missing', await message(ids.general, ids.owner, 'lost'), ids.owner, `${ids.general}/missing.pdf`);
    await attach('local', await message(ids.general, ids.owner, 'blob'), ids.owner, 'blob:http://localhost/abc');
    await attach('prefixed', await message(ids.general, ids.owner, 'prefixed'), ids.owner, `message-attachments/${ids.general}/h.pdf`);

    // Baseline vulnerability present before the upgrade: anyone signed in can read any attachment.
    const leak = await as(db.pool, ids.outsider, `SELECT name FROM storage.objects WHERE name = $1`, [`${ids.secret}/b.pdf`]);
    expect(leak).toHaveLength(1);

    applyMigrations(db.name);
  }, 300_000);

  afterAll(async () => db.pool.end());

  const readable = async (user: string, objectName: string) =>
    (await as(db.pool, user, `SELECT name FROM storage.objects WHERE bucket_id = 'message-attachments' AND name = $1`, [objectName])).length === 1;

  it('keeps every attachment visible to exactly its original audience', async () => {
    expect(await readable(ids.member, `${ids.general}/a.pdf`)).toBe(true);
    expect(await readable(ids.secretMember, `${ids.general}/a.pdf`)).toBe(false);
    expect(await readable(ids.secretMember, `${ids.secret}/b.pdf`)).toBe(true);
    expect(await readable(ids.member, `${ids.secret}/b.pdf`)).toBe(false);
    expect(await readable(ids.owner, `${ids.dmChannel}/c.pdf`)).toBe(true);
    expect(await readable(ids.secretMember, `${ids.dmChannel}/c.pdf`)).toBe(false);
    for (const name of [`${ids.general}/a.pdf`, `${ids.secret}/b.pdf`, `${ids.dmChannel}/c.pdf`]) {
      expect(await readable(ids.outsider, name)).toBe(false);
    }
  });

  it('maps attachments to Drive items without broadening access', async () => {
    const links = (await db.pool.query('SELECT attachment_id, status, item_id FROM file_attachment_drive_links')).rows;
    const byId = new Map(links.map((l) => [l.attachment_id, l]));
    expect(byId.get(attachments.general).status).toBe('linked');
    expect(byId.get(attachments.forward).item_id).toBe(byId.get(attachments.general).item_id);
    expect(byId.get(attachments.link).status).toBe('link_attachment');
    expect(byId.get(attachments.missing).status).toBe('missing_object');
    expect(byId.get(attachments.local).status).toBe('local_url');
    expect(byId.get(attachments.prefixed).status).toBe('linked');

    const generalItem = byId.get(attachments.general).item_id;
    const grants = (await db.pool.query(`SELECT principal_type, channel_id FROM drive_grants WHERE item_id = $1 ORDER BY channel_id`, [generalItem])).rows;
    expect(grants.map((g) => g.principal_type)).toEqual(['channel', 'channel']);
    expect(new Set(grants.map((g) => g.channel_id))).toEqual(new Set([ids.general, ids.dmChannel]));
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM drive_grants WHERE principal_type = 'workspace'`)).rows[0].n).toBe(0);

    // DM content stays private in Drive too.
    const dmItem = byId.get(attachments.dm).item_id;
    expect(await as(db.pool, ids.secretMember, 'SELECT id FROM drive_items WHERE id = $1', [dmItem])).toHaveLength(0);
    expect(await as(db.pool, ids.owner, 'SELECT id FROM drive_items WHERE id = $1', [dmItem])).toHaveLength(1);
  });

  it('is rerunnable and loses no data', async () => {
    const before = (await db.pool.query('SELECT (SELECT count(*) FROM drive_items) AS items, (SELECT count(*) FROM drive_grants) AS grants, (SELECT count(*) FROM file_attachments) AS atts, (SELECT count(*) FROM messages) AS msgs')).rows[0];
    const rerun = (await db.pool.query('SELECT drive_backfill_legacy_attachments(1000) AS r')).rows[0].r;
    expect(rerun.processed).toBe(0);
    const after = (await db.pool.query('SELECT (SELECT count(*) FROM drive_items) AS items, (SELECT count(*) FROM drive_grants) AS grants, (SELECT count(*) FROM file_attachments) AS atts, (SELECT count(*) FROM messages) AS msgs')).rows[0];
    expect(after).toEqual(before);
    expect(Number(after.atts)).toBe(8);
    const report = (await db.pool.query('SELECT status, attachments FROM drive_backfill_report() ORDER BY status')).rows;
    expect(report.map((r) => [r.status, Number(r.attachments)])).toEqual([
      ['link_attachment', 1], ['linked', 5], ['local_url', 1], ['missing_object', 1],
    ]);
  });
});
