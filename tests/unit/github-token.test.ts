import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.APP_JWT_SECRET ??= 'unit-test-secret-that-is-long-enough-for-aes-key';
});

describe('GitHub token sealing', () => {
  it('round-trips a token and never stores it in clear', async () => {
    const { openToken, sealToken } = await import('../../server/github.js');
    const token = 'github_pat_11ABCDEFG0123456789_secretvalue';
    const sealed = sealToken(token);
    expect(JSON.stringify(sealed)).not.toContain('secretvalue');
    expect(openToken(sealed)).toBe(token);
  });

  it('rejects a tampered token', async () => {
    const { openToken, sealToken } = await import('../../server/github.js');
    const sealed = sealToken('github_pat_original');
    const data = Buffer.from(sealed.data, 'base64');
    data[0] ^= 0xff;
    expect(() => openToken({ ...sealed, data: data.toString('base64') })).toThrow();
  });
});

describe('GitHub sign-in state', () => {
  it('round-trips and rejects tampering', async () => {
    const { readState, signState } = await import('../../server/github-accounts.js');
    const state = signState({ k: 'connect', u: '00000000-0000-0000-0000-000000000001', o: 'https://darkspace.example' });
    expect(readState(state)).toMatchObject({ k: 'connect', o: 'https://darkspace.example' });
    const [payload, mac] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ k: 'connect', u: 'someone-else', o: 'https://evil.example', exp: Date.now() + 60_000 })).toString('base64url');
    expect(() => readState(`${forged}.${mac}`)).toThrow();
    expect(() => readState(`${payload}.x${mac.slice(1)}`)).toThrow();
    expect(() => readState(null)).toThrow();
  });

  it('builds a read-only app manifest that returns to this server', async () => {
    const { appManifest } = await import('../../server/github-accounts.js');
    const m = appManifest('https://darkspace.purplehive.pro');
    expect(m.default_permissions).toEqual({ contents: 'read', issues: 'read', metadata: 'read' });
    expect(m.callback_urls).toEqual(['https://darkspace.purplehive.pro/api/github/callback']);
    expect(m.redirect_url).toBe('https://darkspace.purplehive.pro/api/github/app-created');
    expect(m.name.length).toBeLessThanOrEqual(34);
  });
});
