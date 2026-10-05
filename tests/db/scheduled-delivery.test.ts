/**
 * Scheduled message delivery: one transactional path, safe under concurrent
 * workers, no content loss on failure, access rechecked at delivery time.
 * The "worker" is the same function pg_cron runs every minute; no browser is
 * involved, which is the "browser closed" case.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL } from '../../tools/local-supabase/lib.ts';
import {
  addMember,
  admin,
  asService,
  createChannel,
  createUser,
  createWorkspace,
  expectDenied,
  putObject,
  q,
  type TestUser,
} from '../helpers/db.ts';

let sender: TestUser;
let colleague: TestUser;
let ws: string;
let channel: string;

beforeAll(async () => {
  sender = await createUser('sender');
  colleague = await createUser('colleague');
  ws = await createWorkspace(sender, 'Sched');
  await addMember(ws, colleague);
  channel = await createChannel(sender, ws, { members: [colleague] });
});

async function schedule(content: string, opts: { at?: string; status?: string; channelId?: string } = {}) {
  const id = randomUUID();
  await q(sender, `INSERT INTO scheduled_messages (id, user_id, channel_id, content, scheduled_at, sent, status)
                   VALUES ($1, $2, $3, $4, $5, false, $6)`, [
    id, sender.id, opts.channelId ?? channel, content, opts.at ?? new Date(Date.now() - 1000).toISOString(), opts.status ?? 'pending',
  ]);
  return id;
}

const runWorker = () => asService((c) => c.query('SELECT send_due_scheduled_messages() AS n'));

describe('scheduled delivery', () => {
  it('delivers due messages with attachments, exactly once, with no client involved', async () => {
    const id = await schedule('weekly update');
    const path = `${id}/notes.txt`;
    await putObject('message-attachments', path, sender);
    await q(sender, `INSERT INTO scheduled_message_attachments (scheduled_message_id, user_id, file_name, file_size, file_type, file_url)
                     VALUES ($1, $2, 'notes.txt', 10, 'text/plain', $3)`, [id, sender.id, path]);
    await runWorker();
    await runWorker();
    const row = (await admin('SELECT status, sent, sent_message_id FROM scheduled_messages WHERE id = $1', [id]))[0];
    expect(row.status).toBe('sent');
    expect(row.sent).toBe(true);
    const posted = await admin('SELECT id FROM messages WHERE channel_id = $1 AND content = $2', [channel, 'weekly update']);
    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe(row.sent_message_id);
    const files = await admin('SELECT file_url FROM file_attachments WHERE message_id = $1', [row.sent_message_id]);
    expect(files.map((f) => f.file_url)).toEqual([path]);
    // The recipient can read the delivered attachment object.
    expect(await q(colleague, `SELECT name FROM storage.objects WHERE name = $1`, [path])).toHaveLength(1);
  });

  it('never posts twice when two workers run concurrently', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => schedule(`concurrent ${i} ${Date.now()}`)));
    const clients = [new pg.Client(DATABASE_URL), new pg.Client(DATABASE_URL), new pg.Client(DATABASE_URL)];
    await Promise.all(clients.map((c) => c.connect()));
    try {
      await Promise.all(clients.map(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE service_role');
        await c.query('SELECT send_due_scheduled_messages()');
        await c.query('COMMIT');
      }));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    for (const id of ids) {
      const row = (await admin('SELECT content, status FROM scheduled_messages WHERE id = $1', [id]))[0];
      expect(row.status).toBe('sent');
      expect(await admin('SELECT id FROM messages WHERE content = $1', [row.content])).toHaveLength(1);
    }
  });

  it('rechecks access at delivery time and fails visibly when it is gone', async () => {
    const privateChannel = await createChannel(colleague, ws, { isPrivate: true, members: [sender] });
    const id = await schedule('should not be delivered', { channelId: privateChannel });
    await admin('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [privateChannel, sender.id]);
    await runWorker();
    const row = (await admin('SELECT status, last_error, sent FROM scheduled_messages WHERE id = $1', [id]))[0];
    expect(row.status).toBe('failed');
    expect(row.sent).toBe(false);
    expect(row.last_error).toMatch(/no longer have access/);
    expect(await admin('SELECT id FROM messages WHERE content = $1', ['should not be delivered'])).toHaveLength(0);
    const note = await admin(`SELECT title FROM notifications WHERE user_id = $1 AND title = 'Scheduled message not sent'`, [sender.id]);
    expect(note.length).toBeGreaterThan(0);
  });

  it('rolls back the message when an attachment insert fails and retries later', async () => {
    const id = await schedule(`atomic ${Date.now()}`);
    // A scheduled attachment whose row cannot be copied (file_type NULL violates NOT NULL on file_attachments).
    await admin(`ALTER TABLE scheduled_message_attachments ALTER COLUMN file_type DROP NOT NULL`);
    try {
      await admin(`INSERT INTO scheduled_message_attachments (scheduled_message_id, user_id, file_name, file_size, file_type, file_url)
                   VALUES ($1, $2, 'broken', 1, NULL, 'x/y')`, [id, sender.id]);
      await runWorker();
      const row = (await admin('SELECT status, attempts, last_error, next_attempt_at FROM scheduled_messages WHERE id = $1', [id]))[0];
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).not.toBeNull();
      expect(await admin(`SELECT id FROM messages WHERE content LIKE 'atomic %' AND channel_id = $1 AND created_at > now() - interval '1 minute'`, [channel])).toHaveLength(0);
      // The scheduled attachment is still there for the retry - nothing was lost.
      expect(await admin('SELECT id FROM scheduled_message_attachments WHERE scheduled_message_id = $1', [id])).toHaveLength(1);
    } finally {
      await admin(`DELETE FROM scheduled_message_attachments WHERE file_type IS NULL`);
      await admin(`ALTER TABLE scheduled_message_attachments ALTER COLUMN file_type SET NOT NULL`);
    }
  });

  it('holds drafts until the client queues them', async () => {
    const id = await schedule('draft with uploads', { status: 'draft' });
    await runWorker();
    expect((await admin('SELECT status FROM scheduled_messages WHERE id = $1', [id]))[0].status).toBe('draft');
    await q(sender, 'SELECT queue_scheduled_message($1)', [id]);
    await runWorker();
    expect((await admin('SELECT status FROM scheduled_messages WHERE id = $1', [id]))[0].status).toBe('sent');
  });

  it('does not let clients fake delivery state or deliver for others', async () => {
    const id = await schedule('state guard', { at: new Date(Date.now() + 3600_000).toISOString() });
    await expectDenied(q(sender, 'UPDATE scheduled_messages SET sent = true WHERE id = $1', [id]), /managed by the server|permission/i);
    await expectDenied(q(sender, 'SELECT deliver_scheduled_message($1)', [id]));
    await expectDenied(q(sender, 'SELECT send_due_scheduled_messages()'));
    // The fallback RPC only delivers the caller's own due rows.
    const other = await schedule('due for sender');
    const n = await q<{ n: number }>(colleague, 'SELECT deliver_my_due_scheduled_messages() AS n');
    expect(n[0].n).toBe(0);
    expect((await admin('SELECT status FROM scheduled_messages WHERE id = $1', [other]))[0].status).toBe('pending');
    const mine = await q<{ n: number }>(sender, 'SELECT deliver_my_due_scheduled_messages() AS n');
    expect(mine[0].n).toBeGreaterThanOrEqual(1);
  });

  it('resends a delivered message through the same path', async () => {
    const id = await schedule(`resend me ${Date.now()}`);
    await runWorker();
    const content = (await admin('SELECT content FROM scheduled_messages WHERE id = $1', [id]))[0].content;
    const copy = await q<{ id: string }>(sender, 'SELECT resend_scheduled_message($1) AS id', [id]);
    expect((await admin('SELECT status FROM scheduled_messages WHERE id = $1', [copy[0].id]))[0].status).toBe('sent');
    expect(await admin('SELECT id FROM messages WHERE content = $1', [content])).toHaveLength(2);
  });
});
