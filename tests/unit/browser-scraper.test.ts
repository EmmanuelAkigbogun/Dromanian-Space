import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertPublicWebUrl,
  browserScrape,
  browserScraperConfigured,
  browserScraperHealth,
  resetBrowserScraperReadinessCache,
} from '../../server/agents/tools/browser.js';
import type { RunContext } from '../../server/agents/tools/types.js';

const previous = {
  url: process.env.CRAWL4AI_URL,
  token: process.env.CRAWL4AI_API_TOKEN,
  tokenFile: process.env.CRAWL4AI_API_TOKEN_FILE,
};

function context() {
  return {
    signal: new AbortController().signal,
    recordSource: vi.fn(async () => undefined),
  } as unknown as RunContext;
}

describe('private browser scraper', () => {
  beforeEach(() => {
    resetBrowserScraperReadinessCache();
    process.env.CRAWL4AI_URL = 'http://crawl4ai:11235';
    process.env.CRAWL4AI_API_TOKEN = 'unit-test-browser-token';
    delete process.env.CRAWL4AI_API_TOKEN_FILE;
  });

  afterEach(() => {
    resetBrowserScraperReadinessCache();
    vi.unstubAllGlobals();
    if (previous.url === undefined) delete process.env.CRAWL4AI_URL;
    else process.env.CRAWL4AI_URL = previous.url;
    if (previous.token === undefined) delete process.env.CRAWL4AI_API_TOKEN;
    else process.env.CRAWL4AI_API_TOKEN = previous.token;
    if (previous.tokenFile === undefined) delete process.env.CRAWL4AI_API_TOKEN_FILE;
    else process.env.CRAWL4AI_API_TOKEN_FILE = previous.tokenFile;
  });

  it('rejects local, private, link-local and mixed DNS targets', async () => {
    const publicResolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const mixedResolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);

    await expect(assertPublicWebUrl('http://127.0.0.1/admin')).rejects.toThrow('target_rejected');
    await expect(assertPublicWebUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow('target_rejected');
    await expect(assertPublicWebUrl('http://[::1]/')).rejects.toThrow('target_rejected');
    await expect(assertPublicWebUrl('http://intranet/')).rejects.toThrow('target_rejected');
    await expect(assertPublicWebUrl('https://mixed.example/path', mixedResolver)).rejects.toThrow('target_rejected');

    const allowed = await assertPublicWebUrl('https://public.example/path#secret-fragment', publicResolver);
    expect(allowed.toString()).toBe('https://public.example/path');
  });

  it('bounds DNS resolution before handing a target to the browser', async () => {
    const stalledResolver = vi.fn(() => new Promise<never>(() => undefined));
    await expect(assertPublicWebUrl('https://stalled.example/', stalledResolver, 5)).rejects.toThrow('target_rejected');
  });

  it('uses token auth, sends only the URL and fixed cleanup mode, and marks capped output untrusted', async () => {
    const markdown = `${'A'.repeat(1_100)}TAIL-MUST-NOT-APPEAR`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ markdown }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context();

    const output = await browserScrape.run(ctx, { url: 'https://1.1.1.1/page#fragment', max_chars: 1_000 }, { toolUseId: 'tool-1' });

    expect(output.isError).toBeUndefined();
    expect(output.content).toContain('<external_web_page');
    expect(output.content).toContain('trust="untrusted"');
    expect(output.content).toContain('[Page output truncated by Darkspace.]');
    expect(output.content).not.toContain('TAIL-MUST-NOT-APPEAR');
    expect(ctx.recordSource).toHaveBeenCalledWith('web', 'https://1.1.1.1/page', { label: '1.1.1.1' });

    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe('http://crawl4ai:11235/md');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer unit-test-browser-token');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://1.1.1.1/page', f: 'fit' });
    expect(init.redirect).toBe('error');
  });

  it('also accepts the legacy JSON-string markdown response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify('# Page'), { status: 200 })));

    const output = await browserScrape.run(context(), { url: 'https://1.1.1.1/page' }, { toolUseId: 'tool-legacy' });

    expect(output.isError).toBeUndefined();
    expect(output.content).toContain('# Page');
  });

  it('fails closed before contacting the sidecar for a private target', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const output = await browserScrape.run(context(), { url: 'http://10.1.2.3/private' }, { toolUseId: 'tool-2' });

    expect(output).toMatchObject({ isError: true, summary: { error: 'target_rejected' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authenticates readiness, rejects bad credentials and caches the result', async () => {
    expect(browserScraperConfigured()).toBe(true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"browser":{},"crawler":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(browserScraperHealth()).resolves.toEqual({ available: true });
    await expect(browserScraperHealth()).resolves.toEqual({ available: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://crawl4ai:11235/schema', expect.objectContaining({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer unit-test-browser-token');

    resetBrowserScraperReadinessCache();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(browserScraperHealth()).resolves.toEqual({
      available: false,
      reason: 'The private browser scraper rejected its deployment credential.',
    });
  });

  it('maps actionable upstream statuses without returning response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret upstream body', { status: 429 })));
    const output = await browserScrape.run(context(), { url: 'https://1.1.1.1/page' }, { toolUseId: 'tool-busy' });
    expect(output).toMatchObject({ isError: true, summary: { error: 'rate_limited' } });
    expect(output.content).not.toContain('secret upstream body');
  });

  it('refuses redirects from the trusted sidecar endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }));
    const output = await browserScrape.run(context(), { url: 'https://1.1.1.1/page' }, { toolUseId: 'tool-redirect' });
    expect(output).toMatchObject({ isError: true, summary: { error: 'redirect_rejected' } });
  });
});
