import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../../server/env.js';
import {
  allowedUrl,
  checkSignedIn,
  cookieDomainAllowed,
  decryptSession,
  encryptSession,
  normalizeCookies,
  socialBrowserConfigured,
  socialPlatformConstructor,
} from '../../server/social.js';
import type { Page } from 'puppeteer';

describe('social session security', () => {
  const previous = process.env.APP_JWT_SECRET;
  const previousBrowserEndpoint = process.env.SOCIAL_BROWSER_WS_ENDPOINT;
  const previousBrowserToken = process.env.SOCIAL_BROWSER_TOKEN;

  beforeEach(() => {
    process.env.APP_JWT_SECRET = 'test-social-secret-that-is-at-least-thirty-two-characters';
    resetEnvCache();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.APP_JWT_SECRET;
    else process.env.APP_JWT_SECRET = previous;
    if (previousBrowserEndpoint === undefined) delete process.env.SOCIAL_BROWSER_WS_ENDPOINT;
    else process.env.SOCIAL_BROWSER_WS_ENDPOINT = previousBrowserEndpoint;
    if (previousBrowserToken === undefined) delete process.env.SOCIAL_BROWSER_TOKEN;
    else process.env.SOCIAL_BROWSER_TOKEN = previousBrowserToken;
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

  it('fails closed unless a token-protected WebSocket browser is configured', () => {
    delete process.env.SOCIAL_BROWSER_WS_ENDPOINT;
    delete process.env.SOCIAL_BROWSER_TOKEN;
    expect(socialBrowserConfigured()).toBe(false);
    process.env.SOCIAL_BROWSER_WS_ENDPOINT = 'https://browser.internal';
    process.env.SOCIAL_BROWSER_TOKEN = 'secret';
    expect(socialBrowserConfigured()).toBe(false);
    process.env.SOCIAL_BROWSER_WS_ENDPOINT = 'wss://browser.internal';
    expect(socialBrowserConfigured()).toBe(true);
    process.env.SOCIAL_BROWSER_WS_ENDPOINT = 'ws://browser.internal';
    expect(socialBrowserConfigured()).toBe(false);
  });

  it('accepts only cookies for the chosen network', () => {
    const cookies = normalizeCookies([
      { name: 'li_at', value: 'one', domain: '.linkedin.com', secure: true },
      { name: 'li_at', value: 'boundary-bypass', domain: '.maliciouslinkedin.com', secure: true },
      { name: 'session', value: 'steal-me', domain: '.example.com' },
    ], 'linkedin');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'li_at', domain: '.linkedin.com' });
    expect(() => normalizeCookies([{ name: 'x', value: 'y', domain: '.example.com' }], 'linkedin')).toThrow(/No LinkedIn cookies/);
    expect(cookieDomainAllowed('x', '.x.com')).toBe(true);
    expect(cookieDomainAllowed('x', '.evilx.com')).toBe(false);
  });

  it('does not accept an auth-cookie name when the platform page cannot be loaded', async () => {
    const page = {
      setCookie: vi.fn(async () => undefined),
      goto: vi.fn(async () => { throw new Error('network failed'); }),
      url: vi.fn(() => 'about:blank'),
    } as unknown as Page;

    await expect(checkSignedIn(page, 'linkedin', {
      lastValidated: new Date().toISOString(),
      cookies: [{ name: 'li_at', value: 'stale', domain: '.linkedin.com' } as never],
    })).resolves.toBe(false);
    expect(page.goto).toHaveBeenCalledOnce();
  });

  it('requires the auth cookie that belongs to the selected platform', async () => {
    const page = {
      setCookie: vi.fn(async () => undefined),
      goto: vi.fn(),
    } as unknown as Page;

    await expect(checkSignedIn(page, 'x', {
      lastValidated: new Date().toISOString(),
      cookies: [{ name: 'li_at', value: 'wrong-platform', domain: '.x.com' } as never],
    })).resolves.toBe(false);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('requires a positive signed-in page signal on the correct HTTPS host', async () => {
    vi.useFakeTimers();
    try {
      const page = {
        setCookie: vi.fn(async () => undefined),
        goto: vi.fn(async () => null),
        url: vi.fn(() => 'https://www.linkedin.com/feed/'),
        $: vi.fn(async () => ({})),
      } as unknown as Page;
      const checked = checkSignedIn(page, 'linkedin', {
        lastValidated: new Date().toISOString(),
        cookies: [{ name: 'li_at', value: 'current', domain: '.linkedin.com' } as never],
      });
      await vi.advanceTimersByTimeAsync(3000);
      await expect(checked).resolves.toBe(true);
      expect(page.$).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('social platform runtime modules', () => {
  it('loads every supported platform through a valid package subpath', async () => {
    for (const platform of ['x', 'linkedin', 'facebook', 'pinterest', 'tiktok'] as const) {
      await expect(socialPlatformConstructor(platform)).resolves.toBeTypeOf('function');
    }
  });
});
