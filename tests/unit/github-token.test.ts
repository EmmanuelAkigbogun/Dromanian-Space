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
