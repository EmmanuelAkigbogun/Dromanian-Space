import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInstalledPwa, isStandalone } from '../../src/lib/pwa.js';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installed PWA routing', () => {
  it('detects an installed web app without coupling installation to route access', () => {
    vi.stubGlobal('window', {
      darkspaceDesktop: undefined,
      matchMedia: vi.fn(() => ({ matches: true })),
    });
    vi.stubGlobal('navigator', { standalone: false });

    expect(isStandalone()).toBe(true);
    expect(isInstalledPwa()).toBe(true);
  });

  it('keeps the complete workspace route map and navigation available in the PWA', () => {
    const app = read('src/App.tsx');
    const sidebar = read('src/components/layout/Sidebar/Sidebar.tsx');

    expect(app).not.toMatch(/CHAT_ONLY|chatOnlyPath|CHAT_HOME/);
    expect(sidebar).not.toMatch(/CHAT_ONLY|chatOnlyPath/);
    expect(app).toContain('<Route path="/tasks/:taskId" element={<TaskPage />} />');
    expect(app).toContain('<Route path="/drive/item/:itemId" element={<DrivePage />} />');
    expect(app).toContain('<Route path="/crm/:kind/:recordId" element={<CRMPage />} />');
  });

  it('only checks camera and microphone permissions in an installed PWA', () => {
    const banner = read('src/components/pwa/PermissionsBanner/PermissionsBanner.tsx');

    expect(banner).toContain('if (isInstalledPwa()) mediaState()');
  });
});
