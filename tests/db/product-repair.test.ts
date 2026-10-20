import { afterAll, describe, expect, it } from 'vitest';
import { addMember, admin, asService, createUser, createWorkspace, expectDenied, pool, q } from '../helpers/db.ts';

afterAll(async () => pool.end());

describe('canonical General enrollment', () => {
  it('creates General atomically and enrolls the owner', async () => {
    const owner = await createUser('general-owner');
    const workspaceId = await createWorkspace(owner, 'General invariant');
    const rows = await admin<{ channel_id: string; defaults: string[] }>(
      `SELECT c.id AS channel_id, s.default_channel_ids AS defaults
       FROM channels c JOIN workspace_settings s ON s.workspace_id = c.workspace_id
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2::uuid
       WHERE c.workspace_id = $1::uuid AND c.slug = 'general'`,
      [workspaceId, owner.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].defaults).toContain(rows[0].channel_id);
  });

  it('enrolls later admin-added members exactly once', async () => {
    const owner = await createUser('general-admin-owner');
    const member = await createUser('general-member');
    const workspaceId = await createWorkspace(owner, 'General later member');
    await addMember(workspaceId, member);
    const enrolled = await admin<{ count: string }>(
      `SELECT count(*) FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
       WHERE c.workspace_id = $1::uuid AND c.slug = 'general' AND cm.user_id = $2::uuid`,
      [workspaceId, member.id],
    );
    expect(Number(enrolled[0].count)).toBe(1);
  });
});

describe('server-owned call state', () => {
  it('blocks browser writes and expires stale calls through maintenance', async () => {
    const owner = await createUser('call-owner');
    const peer = await createUser('call-peer');
    const workspaceId = await createWorkspace(owner, 'Call security');
    await addMember(workspaceId, peer);
    await expectDenied(q(owner,
      `INSERT INTO call_sessions (workspace_id, call_type, created_by) VALUES ($1, 'direct', $2)`,
      [workspaceId, owner.id],
    ), /permission|row-level security/);

    const [session] = await admin<{ id: string }>(
      `INSERT INTO call_sessions (workspace_id, call_type, created_by, created_at)
       VALUES ($1, 'direct', $2, now() - interval '2 minutes') RETURNING id`,
      [workspaceId, owner.id],
    );
    await admin(
      `INSERT INTO call_participants (call_id, user_id, status) VALUES ($1, $2, 'connected'), ($1, $3, 'ringing')`,
      [session.id, owner.id, peer.id],
    );
    await asService((client) => client.query('SELECT cleanup_stale_calls()'));
    const [result] = await admin<{ status: string }>('SELECT status FROM call_sessions WHERE id = $1', [session.id]);
    expect(result.status).toBe('missed');
  });
});
