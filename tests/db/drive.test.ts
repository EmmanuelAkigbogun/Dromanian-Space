/**
 * Drive permissions, lifecycle and message integration, exercised as distinct
 * users in distinct workspaces (see tests/helpers/db.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  admin,
  createChannel,
  createUser,
  createWorkspace,
  expectDenied,
  postMessage,
  putObject,
  q,
  type TestUser,
} from '../helpers/db.ts';

let owner: TestUser;
let teammate: TestUser;
let channelMate: TestUser;
let adminUser: TestUser;
let outsider: TestUser; // other workspace
let ws: string;
let otherWs: string;
let channel: string;

interface Upload { item_id: string; version_id: string; path: string }

async function upload(user: TestUser, workspace: string, name: string, parent: string | null = null, item: string | null = null) {
  const begin = await q<{ r: Upload }>(user, 'SELECT drive_begin_upload($1, $2, $3, $4, $5, $6) AS r', [
    workspace, parent, name, 'application/pdf', 1234, item,
  ]);
  const { item_id, version_id, path } = begin[0].r;
  await putObject('drive', path, user, 'application/pdf', 1234);
  await q(user, 'SELECT drive_finalize_upload($1)', [version_id]);
  return { itemId: item_id, versionId: version_id, path };
}

const canSee = async (user: TestUser, itemId: string) =>
  (await q(user, 'SELECT id FROM drive_items WHERE id = $1', [itemId])).length === 1;
const canReadObject = async (user: TestUser, path: string, bucket = 'drive') =>
  (await q(user, 'SELECT name FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, path])).length === 1;
const role = async (user: TestUser, itemId: string) =>
  (await q<{ r: string | null }>(user, 'SELECT drive_item_role($1, $2) AS r', [itemId, user.id]))[0].r;

beforeAll(async () => {
  [owner, teammate, channelMate, adminUser, outsider] = await Promise.all([
    createUser('d-owner'), createUser('d-team'), createUser('d-chan'), createUser('d-admin'), createUser('d-out'),
  ]);
  ws = await createWorkspace(owner, 'DriveWs');
  otherWs = await createWorkspace(outsider, 'OtherWs');
  await addMember(ws, teammate);
  await addMember(ws, channelMate);
  await addMember(ws, adminUser, 'admin');
  channel = await createChannel(owner, ws, { isPrivate: true, members: [channelMate] });
});

describe('upload, ownership and sharing', () => {
  it('keeps a new upload private to its owner, including the storage object', async () => {
    const f = await upload(owner, ws, 'Plan.pdf');
    expect(await canSee(owner, f.itemId)).toBe(true);
    expect(await canReadObject(owner, f.path)).toBe(true);
    for (const u of [teammate, adminUser, outsider]) {
      expect(await canSee(u, f.itemId)).toBe(false);
      expect(await canReadObject(u, f.path)).toBe(false);
    }
  });

  it('grants and revokes access through user, channel and workspace grants', async () => {
    const f = await upload(owner, ws, 'Shared.pdf');
    const grant = await q<{ id: string }>(owner, `SELECT * FROM drive_share($1, 'user', $2, 'viewer')`, [f.itemId, teammate.id]);
    expect(await canSee(teammate, f.itemId)).toBe(true);
    expect(await canReadObject(teammate, f.path)).toBe(true);
    expect(await role(teammate, f.itemId)).toBe('viewer');
    await q(owner, 'SELECT drive_unshare($1)', [grant[0].id]);
    expect(await canSee(teammate, f.itemId)).toBe(false);
    expect(await canReadObject(teammate, f.path)).toBe(false);

    await q(owner, `SELECT drive_share($1, 'channel', $2, 'commenter')`, [f.itemId, channel]);
    expect(await role(channelMate, f.itemId)).toBe('commenter');
    expect(await canSee(teammate, f.itemId)).toBe(false); // not in the channel
    await q(owner, `SELECT drive_share($1, 'workspace', NULL, 'viewer')`, [f.itemId]);
    expect(await canSee(teammate, f.itemId)).toBe(true);
    expect(await canSee(outsider, f.itemId)).toBe(false);
  });

  it('refuses to share with people or channels outside the workspace', async () => {
    const f = await upload(owner, ws, 'NoLeak.pdf');
    await expectDenied(q(owner, `SELECT drive_share($1, 'user', $2, 'viewer')`, [f.itemId, outsider.id]), /members of this workspace|permission/i);
    const foreignChannel = await createChannel(outsider, otherWs);
    await expectDenied(q(owner, `SELECT drive_share($1, 'channel', $2, 'viewer')`, [f.itemId, foreignChannel]), /channels you belong to|permission/i);
    await expectDenied(q(teammate, `SELECT drive_share($1, 'user', $2, 'editor')`, [f.itemId, teammate.id]), /cannot change sharing|permission/i);
  });

  it('only lets editors reshare when the owner allows it', async () => {
    const f = await upload(owner, ws, 'Reshare.pdf');
    await q(owner, `SELECT drive_share($1, 'user', $2, 'editor')`, [f.itemId, teammate.id]);
    await expectDenied(q(teammate, `SELECT drive_share($1, 'user', $2, 'viewer')`, [f.itemId, channelMate.id]), /cannot change sharing/i);
    await q(owner, 'SELECT drive_set_sharing_options($1, NULL, true)', [f.itemId]);
    await q(teammate, `SELECT drive_share($1, 'user', $2, 'viewer')`, [f.itemId, channelMate.id]);
    expect(await canSee(channelMate, f.itemId)).toBe(true);
  });

  it('does not let anyone probe other people\'s access', async () => {
    const f = await upload(owner, ws, 'Probe.pdf');
    expect((await q<{ r: string | null }>(outsider, 'SELECT drive_item_role($1, $2) AS r', [f.itemId, owner.id]))[0].r).toBeNull();
    await expectDenied(q(outsider, 'SELECT drive_role_for($1, $2)', [f.itemId, owner.id]));
    await expectDenied(q(teammate, 'SELECT drive_channel_access_gap($1, $2)', [channel, f.itemId]));
  });
});

describe('folders and inheritance', () => {
  it('inherits parent grants, stops at restricted folders, and makes folder owners editors', async () => {
    const root = (await q<{ id: string }>(owner, `SELECT * FROM drive_create_folder($1, NULL, 'Team')`, [ws]))[0].id;
    await q(owner, `SELECT drive_share($1, 'workspace', NULL, 'viewer')`, [root]);
    const child = await upload(owner, ws, 'Inherited.pdf', root);
    expect(await canSee(teammate, child.itemId)).toBe(true);
    expect(await canReadObject(teammate, child.path)).toBe(true);

    const secret = (await q<{ id: string }>(owner, `SELECT * FROM drive_create_folder($1, $2, 'Finance')`, [ws, root]))[0].id;
    await q(owner, 'SELECT drive_set_sharing_options($1, true, NULL)', [secret]);
    const grandchild = await upload(owner, ws, 'Salaries.pdf', secret);
    expect(await canSee(teammate, grandchild.itemId)).toBe(false);
    expect(await canReadObject(teammate, grandchild.path)).toBe(false);

    // teammate gets editor on the shared folder and uploads; the folder owner can edit it.
    await q(owner, `SELECT drive_share($1, 'user', $2, 'editor')`, [root, teammate.id]);
    const teammateFile = await upload(teammate, ws, 'Notes.pdf', root);
    expect(await role(owner, teammateFile.itemId)).toBe('editor');
  });

  it('rejects cycles and cross-workspace moves, and previews access changes', async () => {
    const a = (await q<{ id: string }>(owner, `SELECT * FROM drive_create_folder($1, NULL, 'A')`, [ws]))[0].id;
    const b = (await q<{ id: string }>(owner, `SELECT * FROM drive_create_folder($1, $2, 'B')`, [ws, a]))[0].id;
    await expectDenied(q(owner, 'SELECT drive_move($1, $2)', [a, b]), /into itself/);
    const foreign = (await q<{ id: string }>(outsider, `SELECT * FROM drive_create_folder($1, NULL, 'X')`, [otherWs]))[0].id;
    await expectDenied(q(owner, 'SELECT drive_move($1, $2)', [b, foreign]), /not found|permission/i);

    const shared = (await q<{ id: string }>(owner, `SELECT * FROM drive_create_folder($1, NULL, 'Shared')`, [ws]))[0].id;
    await q(owner, `SELECT drive_share($1, 'channel', $2, 'viewer')`, [shared, channel]);
    const preview = (await q<{ r: { gains: Array<{ type: string; id: string }> } }>(owner, 'SELECT drive_preview_move($1, $2) AS r', [b, shared]))[0].r;
    expect(preview.gains).toContainEqual({ type: 'channel', id: channel });
  });
});

describe('trash and versions', () => {
  it('removes access while trashed and restores it afterwards', async () => {
    const f = await upload(owner, ws, 'Trash.pdf');
    await q(owner, `SELECT drive_share($1, 'user', $2, 'viewer')`, [f.itemId, teammate.id]);
    await q(owner, 'SELECT drive_trash($1)', [f.itemId]);
    expect(await canSee(teammate, f.itemId)).toBe(false);
    expect(await canReadObject(teammate, f.path)).toBe(false);
    expect(await canReadObject(owner, f.path)).toBe(false); // restore before using it again
    expect(await canSee(owner, f.itemId)).toBe(true); // visible in Trash
    await expectDenied(q(teammate, 'SELECT drive_restore($1)', [f.itemId]), /not found|permission/i);
    await q(owner, 'SELECT drive_restore($1)', [f.itemId]);
    expect(await canSee(teammate, f.itemId)).toBe(true);
  });

  it('keeps immutable versions and only the owner can purge', async () => {
    const f = await upload(owner, ws, 'Versioned.pdf');
    await q(owner, `SELECT drive_share($1, 'user', $2, 'editor')`, [f.itemId, teammate.id]);
    const v2 = await upload(teammate, ws, 'Versioned.pdf', null, f.itemId);
    const versions = await admin('SELECT version_no, status FROM drive_versions WHERE item_id = $1 ORDER BY version_no', [f.itemId]);
    expect(versions.map((v) => [v.version_no, v.status])).toEqual([[1, 'ready'], [2, 'ready']]);
    expect((await admin('SELECT current_version_id FROM drive_items WHERE id = $1', [f.itemId]))[0].current_version_id).toBe(v2.versionId);
    await expectDenied(q(teammate, 'UPDATE drive_versions SET storage_path = $2 WHERE id = $1', [f.versionId, 'x']));
    await q(owner, 'SELECT drive_trash($1)', [f.itemId]);
    await expectDenied(q(teammate, 'SELECT drive_delete_forever($1)', [f.itemId]), /only the owner/i);
    await q(owner, 'SELECT drive_delete_forever($1)', [f.itemId]);
    expect(await admin(`SELECT id FROM jobs WHERE kind = 'drive.purge' AND payload->>'item_id' = $1`, [f.itemId])).toHaveLength(1);
  });

  it('rejects finalizing an upload that never reached storage, and cancels cleanly', async () => {
    const begin = await q<{ r: Upload }>(owner, `SELECT drive_begin_upload($1, NULL, 'ghost.pdf', 'application/pdf', 10, NULL) AS r`, [ws]);
    await expectDenied(q(owner, 'SELECT drive_finalize_upload($1)', [begin[0].r.version_id]), /not finished uploading/);
    await expectDenied(q(teammate, 'SELECT drive_finalize_upload($1)', [begin[0].r.version_id]), /not found|permission/i);
    await q(owner, 'SELECT drive_cancel_upload($1)', [begin[0].r.version_id]);
    expect(await admin('SELECT id FROM drive_items WHERE id = $1', [begin[0].r.item_id])).toHaveLength(0);
  });

  it('enforces the upload size limit', async () => {
    await expectDenied(q(owner, `SELECT drive_begin_upload($1, NULL, 'huge.bin', 'application/octet-stream', 999999999999, NULL)`, [ws]), /larger than/);
  });
});

describe('documents', () => {
  it('saves revisions with optimistic concurrency', async () => {
    const doc = (await q<{ id: string; current_revision_no: number }>(owner, `SELECT * FROM drive_create_document($1, NULL, 'Brief', 'v1')`, [ws]))[0];
    await q(owner, `SELECT drive_share($1, 'user', $2, 'editor')`, [doc.id, teammate.id]);
    const first = (await q<{ r: { status: string; revision_no: number } }>(owner, `SELECT drive_save_document($1, 1, 'Brief', 'v2 by owner') AS r`, [doc.id]))[0].r;
    expect(first).toMatchObject({ status: 'saved', revision_no: 2 });
    const stale = (await q<{ r: { status: string; body: string; revision_no: number } }>(teammate, `SELECT drive_save_document($1, 1, 'Brief', 'stale edit') AS r`, [doc.id]))[0].r;
    expect(stale).toMatchObject({ status: 'conflict', revision_no: 2, body: 'v2 by owner' });
    await expectDenied(q(channelMate, `SELECT drive_save_document($1, 2, 'x', 'y')`, [doc.id]), /edit access/);
    expect(await admin('SELECT revision_no FROM drive_document_revisions WHERE item_id = $1 ORDER BY 1', [doc.id])).toHaveLength(2);
  });
});

describe('access requests', () => {
  it('reveals nothing to requesters and notifies the owner', async () => {
    const f = await upload(owner, ws, 'Confidential Strategy.pdf');
    const r1 = (await q<{ r: { status: string } }>(teammate, `SELECT drive_request_access($1, 'viewer', 'please') AS r`, [f.itemId]))[0].r;
    const r2 = (await q<{ r: { status: string } }>(outsider, `SELECT drive_request_access($1, 'viewer', 'please') AS r`, [f.itemId]))[0].r;
    const r3 = (await q<{ r: { status: string } }>(teammate, `SELECT drive_request_access(gen_random_uuid(), 'viewer', NULL) AS r`))[0].r;
    expect([r1.status, r2.status, r3.status]).toEqual(['submitted', 'submitted', 'submitted']);
    expect(await admin('SELECT id FROM drive_access_requests WHERE item_id = $1', [f.itemId])).toHaveLength(1);
    const ownerNote = await admin(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'access_request' AND entity_id = $2`, [owner.id, f.itemId]);
    expect(ownerNote[0].title).toContain('Confidential Strategy.pdf');
    // The requester can see their own request row but not the item.
    expect(await canSee(teammate, f.itemId)).toBe(false);
    const req = await q<{ id: string }>(owner, 'SELECT id FROM drive_access_requests WHERE item_id = $1', [f.itemId]);
    await q(owner, 'SELECT drive_decide_access_request($1, true, NULL)', [req[0].id]);
    expect(await canSee(teammate, f.itemId)).toBe(true);
  });
});

describe('messages and Drive', () => {
  it('backs every stored attachment with a Drive item scoped to the conversation', async () => {
    const path = `${channel}/minutes-${Date.now()}.pdf`;
    await putObject('message-attachments', path, owner, 'application/pdf');
    const msg = await postMessage(owner, channel, 'minutes attached');
    await q(owner, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                    VALUES ($1, $2, 'minutes.pdf', 10, 'application/pdf', $3)`, [msg, owner.id, path]);
    const link = (await admin('SELECT status, item_id FROM file_attachment_drive_links l JOIN file_attachments fa ON fa.id = l.attachment_id WHERE fa.message_id = $1', [msg]))[0];
    expect(link.status).toBe('linked');
    expect(await canSee(channelMate, link.item_id)).toBe(true);
    expect(await canSee(teammate, link.item_id)).toBe(false); // not in the private channel
    expect(await canSee(adminUser, link.item_id)).toBe(false);

    // Forwarding into another conversation adds that audience to the same item.
    const general = await createChannel(owner, ws, { members: [teammate] });
    const fwd = await postMessage(owner, general, 'fwd');
    await q(owner, `INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
                    VALUES ($1, $2, 'minutes.pdf', 10, 'application/pdf', $3)`, [fwd, owner.id, path]);
    expect(await canSee(teammate, link.item_id)).toBe(true);
    expect(await admin(`SELECT id FROM drive_items WHERE id IN (SELECT item_id FROM file_attachment_drive_links WHERE storage_path = $1)`, [path])).toHaveLength(1);

    // Deleting the forward removes that audience, but not the file.
    await q(owner, 'DELETE FROM file_attachments WHERE message_id = $1', [fwd]);
    await q(owner, 'UPDATE messages SET deleted_at = now() WHERE id = $1', [fwd]);
    expect(await canSee(teammate, link.item_id)).toBe(false);
    expect(await canSee(channelMate, link.item_id)).toBe(true);
    expect(await canReadObject(owner, path, 'message-attachments')).toBe(true);
    // The storage object cannot be deleted while Drive still references it.
    expect(await q(owner, `DELETE FROM storage.objects WHERE bucket_id = 'message-attachments' AND name = $1 RETURNING name`, [path])).toHaveLength(0);
  });

  it('attaches Drive items to messages without granting access silently', async () => {
    const f = await upload(owner, ws, 'Deck.pdf');
    const general = await createChannel(owner, ws, { members: [teammate, channelMate] });
    const check = (await q<{ r: Array<{ members_without_access: number; can_grant: boolean }> }>(owner, 'SELECT drive_conversation_access_check($1, $2) AS r', [general, [f.itemId]]))[0].r;
    expect(check[0]).toMatchObject({ members_without_access: 2, can_grant: true });

    const msg = await postMessage(owner, general, 'see deck');
    const res = (await q<{ r: Array<{ granted: boolean; members_without_access: number }> }>(owner, 'SELECT drive_attach_to_message($1, $2, NULL) AS r', [msg, [f.itemId]]))[0].r;
    expect(res[0]).toMatchObject({ granted: false, members_without_access: 2 });
    expect(await canSee(teammate, f.itemId)).toBe(false);
    // The reference is visible, the item is not (client shows "restricted").
    expect(await q(teammate, 'SELECT item_id FROM message_resources WHERE message_id = $1', [msg])).toHaveLength(1);

    const msg2 = await postMessage(owner, general, 'now shared');
    const res2 = (await q<{ r: Array<{ granted: boolean; members_without_access: number }> }>(owner, `SELECT drive_attach_to_message($1, $2, 'viewer') AS r`, [msg2, [f.itemId]]))[0].r;
    expect(res2[0]).toMatchObject({ granted: true, members_without_access: 0 });
    expect(await canSee(teammate, f.itemId)).toBe(true);

    // A non-manager cannot grant through a message.
    const other = await upload(teammate, ws, 'Theirs.pdf');
    await q(teammate, `SELECT drive_share($1, 'user', $2, 'viewer')`, [other.itemId, owner.id]);
    const msg3 = await postMessage(owner, general, 'their file');
    const res3 = (await q<{ r: Array<{ granted: boolean }> }>(owner, `SELECT drive_attach_to_message($1, $2, 'viewer') AS r`, [msg3, [other.itemId]]))[0].r;
    expect(res3[0].granted).toBe(false);
    expect(await canSee(channelMate, other.itemId)).toBe(false);
  });
});

describe('workspace boundaries', () => {
  it('denies every Drive mutation from another tenant', async () => {
    const f = await upload(owner, ws, 'Tenant.pdf');
    await expectDenied(q(outsider, `SELECT drive_rename($1, 'pwned')`, [f.itemId]));
    await expectDenied(q(outsider, 'SELECT drive_trash($1)', [f.itemId]));
    await expectDenied(q(outsider, `SELECT drive_share($1, 'user', $2, 'editor')`, [f.itemId, outsider.id]));
    await expectDenied(q(outsider, `SELECT drive_begin_upload($1, NULL, 'x.pdf', 'application/pdf', 1, NULL)`, [ws]));
    await expectDenied(q(outsider, `SELECT drive_add_comment($1, 'hi', NULL)`, [f.itemId]));
    expect(await q(outsider, 'SELECT * FROM drive_list($1, $2)', [ws, 'all'])).toHaveLength(0);
  });

  it('drops access when a member is removed from the workspace', async () => {
    const leaver = await createUser('d-leaver');
    await addMember(ws, leaver);
    const f = await upload(owner, ws, 'Before.pdf');
    await q(owner, `SELECT drive_share($1, 'user', $2, 'viewer')`, [f.itemId, leaver.id]);
    expect(await canSee(leaver, f.itemId)).toBe(true);
    await q(owner, 'SELECT remove_workspace_member($1, $2, $3)', [ws, leaver.id, owner.id]);
    expect(await canSee(leaver, f.itemId)).toBe(false);
    expect(await canReadObject(leaver, f.path)).toBe(false);
  });
});
