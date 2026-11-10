import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareClient, DEFAULT_TUNNEL_SERVICE, mergeTunnelIngress, normalizeDomain, normalizeHostname, normalizeRecordName } from '../../server/cloudflare.js';
import { openCloudflareConnection, sealCloudflareConnection } from '../../server/cloudflare-secrets.js';

describe('Cloudflare domain management', () => {
  const previous = process.env.APP_JWT_SECRET;
  beforeEach(() => { process.env.APP_JWT_SECRET = 'test-cloudflare-secret-that-is-at-least-thirty-two-characters'; });
  afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.APP_JWT_SECRET; else process.env.APP_JWT_SECRET = previous; });

  it('encrypts credentials and detects tampering', () => {
    const connection = { apiToken: 'secret-cloudflare-api-token', accountId: 'a'.repeat(32) };
    const sealed = sealCloudflareConnection(connection);
    expect(JSON.stringify(sealed)).not.toContain(connection.apiToken);
    expect(openCloudflareConnection(sealed)).toEqual(connection);
    sealed.ciphertext = `${sealed.ciphertext.slice(0, -2)}aa`;
    expect(() => openCloudflareConnection(sealed)).toThrow();
  });

  it('validates zones and prevents hostnames escaping their zone', () => {
    expect(normalizeDomain('Example.COM.')).toBe('example.com');
    expect(normalizeHostname('app', 'example.com')).toBe('app.example.com');
    expect(normalizeHostname('@', 'example.com')).toBe('example.com');
    expect(normalizeRecordName('_acme-challenge', 'example.com')).toBe('_acme-challenge.example.com');
    expect(() => normalizeHostname('app.attacker.test', 'example.com')).toThrow(/must belong/);
    expect(() => normalizeDomain('localhost')).toThrow(/valid domain/);
  });

  it('preserves existing tunnel routes and keeps the catch-all last', () => {
    const current = [
      { hostname: 'one.example.com', service: 'http://one:80' },
      { hostname: 'app.example.com', service: 'http://old:80' },
      { service: 'http_status:404' },
    ];
    expect(mergeTunnelIngress(current, 'app.example.com', 'http://new:80')).toEqual([
      { hostname: 'one.example.com', service: 'http://one:80' },
      { hostname: 'app.example.com', service: 'http://new:80' },
      { service: 'http_status:404' },
    ]);
  });

  it.each([
    { configuredService: undefined, expectedService: DEFAULT_TUNNEL_SERVICE },
    { configuredService: 'http://host.docker.internal:3008', expectedService: 'http://host.docker.internal:3008' },
  ])('publishes with $expectedService when that is the effective tunnel service', async ({ configuredService, expectedService }) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const result = url.includes('/configurations') && init?.method !== 'PUT'
        ? { config: { ingress: [{ service: 'http_status:404' }] } }
        : url.includes('/dns_records?')
          ? []
          : url.includes('/dns_records')
            ? { id: 'record-id', type: 'CNAME', name: 'app.example.com', content: `${'b'.repeat(32)}.cfargotunnel.com`, ttl: 1 }
            : {};
      return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new CloudflareClient({
      apiToken: 'super-secret-token',
      accountId: 'a'.repeat(32),
      tunnelId: 'b'.repeat(32),
      defaultService: configuredService,
    }, fetcher as typeof fetch);

    await client.publishHostname({ id: 'c'.repeat(32), name: 'example.com', status: 'active', name_servers: [] }, 'app');

    const configurationWrite = requests.find(({ url, init }) => url.includes('/configurations') && init?.method === 'PUT');
    expect(configurationWrite).toBeDefined();
    expect(JSON.parse(String(configurationWrite?.init?.body))).toMatchObject({
      config: { ingress: [{ hostname: 'app.example.com', service: expectedService }, { service: 'http_status:404' }] },
    });
  });

  it('uses the production web container port in validation help', () => {
    expect(() => mergeTunnelIngress([], 'app.example.com', 'web:8080')).toThrow(DEFAULT_TUNNEL_SERVICE);
  });

  it('returns a safe Cloudflare error', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'permission denied' }] }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const client = new CloudflareClient({ apiToken: 'super-secret-token', accountId: 'a'.repeat(32) }, fetcher as typeof fetch);
    await expect(client.verify()).rejects.toThrow('permission denied');
  });
});
