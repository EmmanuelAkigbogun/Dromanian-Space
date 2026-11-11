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

  it('treats an empty maybeSingle read as null without requesting a 406 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await platform
      .from<{ hidden: string[] } | null>('workspace_member_features')
      .select('hidden')
      .eq('workspace_id', 'workspace-1')
      .maybeSingle();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/db/workspace_member_features?select=hidden&workspace_id=eq.workspace-1');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(result).toMatchObject({ data: null, error: null });
  });

  it('unwraps one maybeSingle read and rejects an ambiguous result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ hidden: ['drive'] }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ hidden: [] }, { hidden: ['ai'] }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const one = await platform.from<{ hidden: string[] } | null>('workspace_member_features').select('hidden').maybeSingle();
    const many = await platform.from<{ hidden: string[] } | null>('workspace_member_features').select('hidden').maybeSingle();

    expect(one).toMatchObject({ data: { hidden: ['drive'] }, error: null });
    expect(many).toMatchObject({ data: null, error: { code: 'PGRST116', status: 406 } });
  });
});
