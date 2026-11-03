import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareClient, mergeTunnelIngress, normalizeDomain, normalizeHostname, normalizeRecordName } from '../../server/cloudflare.js';
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

  it('returns a safe Cloudflare error', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'permission denied' }] }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const client = new CloudflareClient({ apiToken: 'super-secret-token', accountId: 'a'.repeat(32) }, fetcher as typeof fetch);
    await expect(client.verify()).rejects.toThrow('permission denied');
  });
});
