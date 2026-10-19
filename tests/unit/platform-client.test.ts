import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../src/lib/platform.js';

describe('browser database client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('marks RPC and write bodies as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(0), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await platform.rpc('get_notification_unread_count');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe('{}');
  });
});
