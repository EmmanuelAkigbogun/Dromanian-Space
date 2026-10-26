import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../server/env.js';
import { allowedUrl, decryptSession, encryptSession, normalizeCookies } from '../../server/social.js';

describe('social session security', () => {
  const previous = process.env.APP_JWT_SECRET;

  beforeEach(() => {
    process.env.APP_JWT_SECRET = 'test-social-secret-that-is-at-least-thirty-two-characters';
    resetEnvCache();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.APP_JWT_SECRET;
    else process.env.APP_JWT_SECRET = previous;
    resetEnvCache();
  });

  it('encrypts account sessions and rejects tampering', () => {
    const session = { lastValidated: new Date().toISOString(), cookies: [{ name: 'li_at', value: 'secret-cookie' }] };
    const sealed = encryptSession(session);
    expect(sealed).not.toContain('secret-cookie');
    expect(decryptSession(sealed)).toMatchObject(session);
    const parts = sealed.split('.');
    parts[3] = `${parts[3].slice(0, -2)}aa`;
    expect(() => decryptSession(parts.join('.'))).toThrow();
  });

  it('keeps the remote browser on the social network and known sign-in providers', () => {
    expect(allowedUrl('linkedin', 'https://www.linkedin.com/feed/')).toBe(true);
    expect(allowedUrl('linkedin', 'https://accounts.google.com/signin')).toBe(true);
    expect(allowedUrl('linkedin', 'http://linkedin.com/')).toBe(false);
    expect(allowedUrl('linkedin', 'https://linkedin.com.evil.example/')).toBe(false);
    expect(allowedUrl('linkedin', 'http://127.0.0.1:3000/private')).toBe(false);
  });

  it('accepts only cookies for the chosen network', () => {
    const cookies = normalizeCookies([
      { name: 'li_at', value: 'one', domain: '.linkedin.com', secure: true },
      { name: 'session', value: 'steal-me', domain: '.example.com' },
    ], 'linkedin');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'li_at', domain: '.linkedin.com' });
    expect(() => normalizeCookies([{ name: 'x', value: 'y', domain: '.example.com' }], 'linkedin')).toThrow(/No LinkedIn cookies/);
  });
});
