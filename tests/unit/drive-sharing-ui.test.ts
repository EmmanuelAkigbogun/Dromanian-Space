import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

describe('Drive sharing UI', () => {
  it('uses the existing permission-aware Drive ACL operations', () => {
    const dialog = read('src/components/drive/DriveShareDialog/DriveShareDialog.tsx');

    expect(dialog).toContain("platform.rpc('drive_get_access'");
    expect(dialog).toContain("platform.rpc('drive_share'");
    expect(dialog).toContain("platform.rpc('drive_unshare'");
    expect(dialog).toContain("platform.rpc('drive_set_sharing_options'");
    expect(dialog).toContain("platform.rpc('drive_decide_access_request'");
    expect(dialog).toContain('Copying the link never changes permissions.');
    expect(dialog).toContain("platform.from('channel_members')");
    expect(dialog).toContain('member.id !== currentAccess.owner_id && member.id !== userId');
  });

  it('exposes Share for Drive files and folders without routing through a public link', () => {
    const browser = read('src/app/routes/Drive/DrivePage.tsx');
    const item = read('src/app/routes/Drive/DriveItem.tsx');

    expect(browser).toContain('className={d.cardShareButton}');
    expect(browser).toContain('className={d.shareAction}');
    expect(browser).toContain('setShareItem(focusedItem)');
    expect(browser).toContain('<DriveShareDialog');
    expect(item).toContain('<DriveShareDialog');
  });
});
