/**
 * Regression tests for the gaps closed by 20261004000100_security_hardening.sql.
 * Every test uses distinct auth users and, where relevant, distinct workspaces.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  admin,
  asAnon,
  asUser,
  createChannel,
  createUser,
  createWorkspace,
  expectDenied,
  postMessage,
  putObject,
  q,
  type TestUser,
} from '../helpers/db.ts';

let owner: TestUser; // owner of workspace A
let adminA: TestUser; // admin of workspace A
let member: TestUser; // member of A, in the private channel
let outsider: TestUser; // member of A, NOT in the private channel
let attacker: TestUser; // owner of workspace B only
let wsA: string;
let wsB: string;
let privateChannel: string;
let publicChannel: string;
let attackerChannel: string;

beforeAll(async () => {
  [owner, adminA, member, outsider, attacker] = await Promise.all([
    createUser('owner'),
    createUser('admin'),
    createUser('member'),
    createUser('outsider'),
    createUser('attacker'),
  ]);
  wsA = await createWorkspace(owner, 'Alpha');
  wsB = await createWorkspace(attacker, 'Bravo');
  await addMember(wsA, adminA, 'admin');
  await addMember(wsA, member);
  await addMember(wsA, outsider);
  privateChannel = await createChannel(owner, wsA, { isPrivate: true, members: [member] });
  publicChannel = await createChannel(owner, wsA, { members: [member, outsider] });
  attackerChannel = await createChannel(attacker, wsB);
});

describe('storage: message-attachments', () => {
  it('only lets the uploader or people who can see a referencing message read an object', async () => {
    const path = `${privateChannel}/report-${Date.now()}.pdf`;
    await putObject('message-attachments', path, owner, 'application/pdf');
    const messageId = await postMessage(owner, privateChannel, 'see attached');
    await q(owner, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                    VALUES ($1, $2, 'report.pdf', 10, 'application/pdf', $3)`, [messageId, owner.id, path]);

    const read = (u: TestUser) =>
      q(u, `SELECT name FROM storage.objects WHERE bucket_id = 'message-attachments' AND name = $1`, [path]);

    expect(await read(owner)).toHaveLength(1);
    expect(await read(member)).toHaveLength(1);
    expect(await read(outsider)).toHaveLength(0); // same workspace, not in the private channel
    expect(await read(adminA)).toHaveLength(0); // admin role grants no implicit access
    expect(await read(attacker)).toHaveLength(0); // other tenant
    expect(await asAnon(async (c) => (await c.query(`SELECT name FROM storage.objects WHERE name = $1`, [path])).rows)).toHaveLength(0);
  });

  it('rejects an attachment row that points at an object the inserter cannot read', async () => {
    const victimPath = `${privateChannel}/secret-${Date.now()}.txt`;
    await putObject('message-attachments', victimPath, owner);
    const attackerMessage = await postMessage(attacker, attackerChannel, 'look');
    await expectDenied(
      q(attacker, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                   VALUES ($1, $2, 'stolen.txt', 1, 'text/plain', $3)`, [attackerMessage, attacker.id, victimPath]),
    );
    // Using the "message-attachments/" prefixed form is the same object.
    await expectDenied(
      q(attacker, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                   VALUES ($1, $2, 'stolen.txt', 1, 'text/plain', $3)`, [attackerMessage, attacker.id, `message-attachments/${victimPath}`]),
    );
  });

  it('lets a channel member forward an attachment they can read', async () => {
    const path = `${publicChannel}/forward-${Date.now()}.txt`;
    await putObject('message-attachments', path, owner);
    const original = await postMessage(owner, publicChannel, 'original');
    await q(owner, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                    VALUES ($1, $2, 'f.txt', 1, 'text/plain', $3)`, [original, owner.id, path]);
    const forward = await postMessage(member, privateChannel, 'fwd');
    const rows = await q(member, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                                  VALUES ($1, $2, 'f.txt', 1, 'text/plain', $3) RETURNING id`, [forward, member.id, path]);
    expect(rows).toHaveLength(1);
  });

  it('prevents deleting objects that are still referenced or owned by someone else', async () => {
    const path = `${publicChannel}/keep-${Date.now()}.txt`;
    await putObject('message-attachments', path, owner);
    const msg = await postMessage(owner, publicChannel, 'keep');
    await q(owner, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                    VALUES ($1, $2, 'k.txt', 1, 'text/plain', $3)`, [msg, owner.id, path]);
    const del = (u: TestUser) =>
      q(u, `DELETE FROM storage.objects WHERE bucket_id = 'message-attachments' AND name = $1 RETURNING name`, [path]);
    expect(await del(attacker)).toHaveLength(0);
    expect(await del(member)).toHaveLength(0);
    expect(await del(owner)).toHaveLength(0); // still referenced
    // Removing the attachment row does not free the object: its Drive item keeps
    // it (files outlive messages; removal goes through Drive trash and purge).
    await q(owner, 'DELETE FROM file_attachments WHERE message_id = $1', [msg]);
    expect(await del(owner)).toHaveLength(0);
    // An abandoned upload that nothing references can be removed by its uploader.
    const orphan = `${publicChannel}/orphan-${Date.now()}.txt`;
    await putObject('message-attachments', orphan, owner);
    expect(await q(member, `DELETE FROM storage.objects WHERE bucket_id = 'message-attachments' AND name = $1 RETURNING name`, [orphan])).toHaveLength(0);
    expect(await q(owner, `DELETE FROM storage.objects WHERE bucket_id = 'message-attachments' AND name = $1 RETURNING name`, [orphan])).toHaveLength(1);
  });
});

describe('internal functions are not client-callable', () => {
  const internal = [
    `SELECT automation_execute_action(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', NULL, 'post_message', '{}'::jsonb, '{}'::jsonb)`,
    `SELECT evaluate_automation_rules(gen_random_uuid(), 'message.posted', gen_random_uuid(), '{}'::jsonb)`,
    `SELECT * FROM automation_resolve_dm(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    `SELECT send_due_scheduled_messages()`,
    `SELECT send_due_reminders()`,
    `SELECT apply_message_retention()`,
  ];
  for (const sql of internal) {
    it(`denies: ${sql.slice(7, 50)}…`, async () => {
      await expectDenied(q(attacker, sql));
      await expectDenied(asAnon((c) => c.query(sql)));
    });
  }

  it('leaves no SECURITY DEFINER function executable by anon except the allowlist', async () => {
    const rows = await admin<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
        AND pg_get_function_result(p.oid) <> 'trigger'
        AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
    const allowed = new Set([
      'get_workspace_invite_link_info', 'user_is_workspace_member', 'user_is_workspace_admin', 'user_is_channel_member',
      'is_workspace_member', 'is_workspace_admin', 'is_workspace_member_for_task', 'is_task_assignee', 'is_task_creator',
      'is_project_owner', 'is_project_admin', 'is_project_member', 'is_project_editor', 'is_project_viewer',
      'is_project_readable', 'get_project_workspace_id', 'can_view_automation_rule', 'can_manage_automation_rule',
      'is_automation_owner_admin', 'channel_workspace_id', 'user_is_dm_participant',
    ]);
    const unexpected = rows.map((r) => r.proname).filter((n) => !allowed.has(n));
    expect(unexpected).toEqual([]);
  });
});

describe('identity is never taken from parameters', () => {
  it('rejects change_member_role with a spoofed caller', async () => {
    const res = await q<{ r: { allowed: boolean } }>(outsider, 'SELECT change_member_role($1, $2, $3, $4) AS r', [
      wsA, member.id, 'admin', owner.id,
    ]);
    expect(res[0].r.allowed).toBe(false);
    expect((await admin('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsA, member.id]))[0].role).toBe('member');
  });

  it('never assigns the owner role through change_member_role', async () => {
    const res = await q<{ r: { allowed: boolean } }>(owner, 'SELECT change_member_role($1, $2, $3, $4) AS r', [
      wsA, member.id, 'owner', owner.id,
    ]);
    expect(res[0].r.allowed).toBe(false);
  });

  it('blocks direct role escalation by an admin', async () => {
    await expectDenied(q(adminA, `UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`, [wsA, adminA.id]), /change_member_role|permission/i);
    await expectDenied(q(adminA, `UPDATE workspaces SET owner_id = $2 WHERE id = $1`, [wsA, adminA.id]), /transfer_workspace_ownership|permission/i);
  });

  it('lets only owners/admins remove members', async () => {
    const res = await q<{ r: { allowed: boolean } }>(member, 'SELECT remove_workspace_member($1, $2, $3) AS r', [wsA, outsider.id, member.id]);
    expect(res[0].r.allowed).toBe(false);
  });

  it('refuses to create a workspace on behalf of someone else', async () => {
    await expectDenied(q(attacker, `SELECT create_workspace_with_owner('x', 'x-' || gen_random_uuid(), $1, NULL)`, [owner.id]), /yourself|42501|permission/i);
  });

  it('only accepts an invitation for the signed-in email', async () => {
    const invite = await admin<{ id: string }>(
      `INSERT INTO invitations (workspace_id, invited_by, email, role) VALUES ($1, $2, 'someone-else@example.test', 'member') RETURNING id`,
      [wsA, owner.id],
    );
    const res = await q<{ r: { success: boolean } }>(attacker, 'SELECT accept_workspace_invitation($1, $2, $3) AS r', [
      invite[0].id, attacker.id, 'someone-else@example.test',
    ]);
    expect(res[0].r.success).toBe(false);
    expect(await admin('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsA, attacker.id])).toHaveLength(0);
  });
});

describe('messages', () => {
  it('lets authors edit, admins only soft-delete, and blocks other members', async () => {
    const id = await postMessage(member, publicChannel, 'original text');
    await q(member, `UPDATE messages SET content = 'edited', edited_at = now() WHERE id = $1`, [id]);
    expect((await admin('SELECT content FROM messages WHERE id = $1', [id]))[0].content).toBe('edited');

    const updatedByOther = await q(outsider, `UPDATE messages SET content = 'hijacked' WHERE id = $1 RETURNING id`, [id]);
    expect(updatedByOther).toHaveLength(0);

    // An admin who is not in the channel cannot even see the message.
    expect(await q(adminA, `UPDATE messages SET deleted_at = now() WHERE id = $1 RETURNING id`, [id])).toHaveLength(0);
    // After joining the public channel the admin may moderate by soft-deleting, but not rewrite.
    await q(adminA, 'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [publicChannel, adminA.id]);
    await expectDenied(q(adminA, `UPDATE messages SET content = 'admin rewrite' WHERE id = $1`, [id]), /author|permission/i);
    const deleted = await q(adminA, `UPDATE messages SET deleted_at = now() WHERE id = $1 RETURNING id`, [id]);
    expect(deleted).toHaveLength(1);
    await q(adminA, 'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [publicChannel, adminA.id]);
  });

  it('keeps private channel messages away from admins and outsiders', async () => {
    await postMessage(owner, privateChannel, 'confidential roadmap');
    for (const u of [adminA, outsider, attacker]) {
      expect(await q(u, 'SELECT id FROM messages WHERE channel_id = $1', [privateChannel])).toHaveLength(0);
    }
    expect((await q(member, 'SELECT id FROM messages WHERE channel_id = $1', [privateChannel])).length).toBeGreaterThan(0);
  });

  it('does not let an admin add themselves to a private channel', async () => {
    await expectDenied(q(adminA, 'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [privateChannel, adminA.id]));
  });

  it('does not let anyone add a user from another workspace to a channel', async () => {
    await expectDenied(q(owner, 'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [publicChannel, attacker.id]));
    await expectDenied(q(attacker, 'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [publicChannel, attacker.id]));
  });

  it('hides private channel membership from non-members', async () => {
    expect(await q(outsider, 'SELECT user_id FROM channel_members WHERE channel_id = $1', [privateChannel])).toHaveLength(0);
    expect((await q(outsider, 'SELECT user_id FROM channel_members WHERE channel_id = $1', [publicChannel])).length).toBe(3);
  });
});

describe('direct messages', () => {
  it('keeps DM metadata and content private to participants', async () => {
    const convId = (await q<{ id: string }>(owner, 'SELECT create_direct_conversation($1, $2, $3) AS id', [wsA, owner.id, member.id]))[0].id;
    const channel = (await admin<{ channel_id: string }>('SELECT channel_id FROM direct_conversations WHERE id = $1', [convId]))[0].channel_id;
    await postMessage(member, channel, 'just between us');
    for (const u of [outsider, adminA, attacker]) {
      expect(await q(u, 'SELECT id FROM direct_conversations WHERE id = $1', [convId])).toHaveLength(0);
      expect(await q(u, 'SELECT user_id FROM direct_conversation_participants WHERE conversation_id = $1', [convId])).toHaveLength(0);
      expect(await q(u, 'SELECT id FROM messages WHERE channel_id = $1', [channel])).toHaveLength(0);
    }
    expect(await q(member, 'SELECT id FROM direct_conversations WHERE id = $1', [convId])).toHaveLength(1);
    await expectDenied(q(adminA, 'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channel, adminA.id]));
    await expectDenied(q(owner, 'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channel, outsider.id]));
  });
});

describe('notifications', () => {
  it('blocks notifications to people outside a shared workspace and actor spoofing', async () => {
    await expectDenied(q(attacker, `INSERT INTO notifications (user_id, type, title, message, workspace_id) VALUES ($1, 'mention', 'hi', 'phish', $2)`, [owner.id, wsB]));
    await expectDenied(q(attacker, `SELECT create_notification($1, 'mention', 't', 'm', NULL, 'messaging', NULL, NULL, NULL, NULL)`, [owner.id]));
    await expectDenied(q(member, `INSERT INTO notifications (user_id, type, title, message, workspace_id, actor_id) VALUES ($1, 'mention', 't', 'm', $2, $3)`, [outsider.id, wsA, owner.id]));
    await q(member, `INSERT INTO notifications (user_id, type, title, message, workspace_id, actor_id) VALUES ($1, 'mention', 't', 'm', $2, $3)`, [outsider.id, wsA, member.id]);
    const viaRpc = await q<{ id: string }>(member, `SELECT create_notification($1, 'mention', 'rpc', 'm', NULL, 'messaging', NULL, NULL, $2, $3) AS id`, [outsider.id, member.id, wsA]);
    expect(viaRpc[0].id).toBeTruthy();
    expect((await q(outsider, `SELECT title FROM notifications WHERE user_id = $1 AND actor_id = $2`, [outsider.id, member.id])).length).toBe(2);
  });
});

describe('membership removal', () => {
  it('removes channel, DM and project access when a member is removed', async () => {
    const leaver = await createUser('leaver');
    await addMember(wsA, leaver);
    const channel = await createChannel(owner, wsA, { isPrivate: true, members: [leaver] });
    await postMessage(owner, channel, 'visible while a member');
    expect((await q(leaver, 'SELECT id FROM messages WHERE channel_id = $1', [channel])).length).toBe(1);
    const res = await q<{ r: { allowed: boolean } }>(owner, 'SELECT remove_workspace_member($1, $2, $3) AS r', [wsA, leaver.id, owner.id]);
    expect(res[0].r.allowed).toBe(true);
    expect(await q(leaver, 'SELECT id FROM messages WHERE channel_id = $1', [channel])).toHaveLength(0);
    expect(await admin('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel, leaver.id])).toHaveLength(0);
  });

  it('treats a stale channel membership as no access', async () => {
    const ghost = await createUser('ghost');
    await addMember(wsA, ghost);
    const channel = await createChannel(owner, wsA, { isPrivate: true, members: [ghost] });
    await postMessage(owner, channel, 'secret');
    // Simulate a legacy row left behind: remove workspace membership without the trigger.
    await admin('ALTER TABLE workspace_members DISABLE TRIGGER trg_workspace_member_removed');
    try {
      await admin('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsA, ghost.id]);
    } finally {
      await admin('ALTER TABLE workspace_members ENABLE TRIGGER trg_workspace_member_removed');
    }
    expect(await admin('SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2', [channel, ghost.id])).toHaveLength(1);
    expect(await q(ghost, 'SELECT id FROM messages WHERE channel_id = $1', [channel])).toHaveLength(0);
  });

  it('still lets the owner delete their workspace (cascades are not blocked by guards)', async () => {
    const solo = await createUser('solo');
    const ws = await createWorkspace(solo, 'Disposable');
    await createChannel(solo, ws);
    const deleted = await q(solo, 'DELETE FROM workspaces WHERE id = $1 RETURNING id', [ws]);
    expect(deleted).toHaveLength(1);
  });
});

describe('tasks', () => {
  it('refuses task RPCs from other tenants', async () => {
    const taskId = (await q<{ id: string }>(owner, `SELECT create_task($1, 'Quarterly plan') AS id`, [wsA]))[0].id;
    await expectDenied(q(attacker, 'SELECT delete_task($1)', [taskId]));
    await expectDenied(q(attacker, `SELECT update_task($1, 'pwned')`, [taskId]));
    await expectDenied(q(attacker, `SELECT create_task($1, 'spam')`, [wsA]));
    expect(await q(attacker, 'SELECT * FROM get_workspace_tasks($1)', [wsA])).toHaveLength(0);
    expect((await admin('SELECT title FROM tasks WHERE id = $1', [taskId]))[0].title).toBe('Quarterly plan');
  });
});

describe('global search', () => {
  it('does not reveal private channels or other workspaces', async () => {
    const name = `zebra${Date.now()}`;
    await createChannel(owner, wsA, { name, isPrivate: true });
    expect(await q(outsider, 'SELECT * FROM global_search($1, $2, 20)', [name, wsA])).toHaveLength(0);
    expect(await q(attacker, 'SELECT * FROM global_search($1, $2, 20)', [name, wsA])).toHaveLength(0);
    expect((await q(owner, 'SELECT * FROM global_search($1, $2, 20)', [name, wsA])).length).toBe(1);
  });
});

describe('anonymous access', () => {
  it('cannot call workspace RPCs or read tenant data', async () => {
    await expectDenied(asAnon((c) => c.query(`SELECT create_task($1, 'x')`, [wsA])));
    await expectDenied(asAnon((c) => c.query(`SELECT get_workspace_member_count($1)`, [wsA])));
    const rows = await asAnon(async (c) => (await c.query('SELECT id FROM messages LIMIT 5')).rows);
    expect(rows).toHaveLength(0);
  });
});

void asUser;
