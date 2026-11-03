import { HttpError } from './http.js';
import type { CloudflareConnection } from './cloudflare-secrets.js';

const API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> { success: boolean; result: T; errors?: Array<{ code?: number; message?: string }>; result_info?: { page: number; total_pages: number } }
export interface CloudflareZone { id: string; name: string; status: string; name_servers: string[]; original_name_servers?: string[] }
export interface DnsRecord { id: string; type: string; name: string; content: string; ttl: number; proxied?: boolean; priority?: number; comment?: string }
export interface IngressRule { hostname?: string; service: string; originRequest?: Record<string, unknown> }

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new HttpError(400, 'invalid_domain', 'Enter a valid domain name, for example example.com.');
  }
  return domain;
}

export function normalizeHostname(value: string, zone: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  const hostname = candidate === '@' || candidate === '' ? zone : candidate.includes('.') ? candidate : `${candidate}.${zone}`;
  if (hostname !== zone && !hostname.endsWith(`.${zone}`)) throw new HttpError(400, 'invalid_hostname', `The hostname must belong to ${zone}.`);
  normalizeDomain(hostname);
  return hostname;
}

export function normalizeRecordName(value: string, zone: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  const name = candidate === '@' ? zone : candidate.includes('.') ? candidate : `${candidate}.${zone}`;
  if (name !== zone && !name.endsWith(`.${zone}`)) throw new HttpError(400, 'invalid_hostname', `The record must belong to ${zone}.`);
  if (name.length > 253 || !/^(?:\*\.)?(?:[_a-z0-9-]+\.)+[a-z0-9-]{2,63}$/.test(name)) throw new HttpError(400, 'invalid_hostname', 'Enter a valid DNS record name.');
  return name;
}

export function mergeTunnelIngress(existing: IngressRule[], hostname: string, service: string): IngressRule[] {
  if (!/^https?:\/\//i.test(service) && !/^(tcp|ssh|rdp|unix):\/\//i.test(service)) {
    throw new HttpError(400, 'invalid_service', 'Tunnel service must be a supported URL such as http://web:80.');
  }
  const filtered = existing.filter((rule) => rule.hostname?.toLowerCase() !== hostname.toLowerCase());
  const catchAll = filtered.findIndex((rule) => !rule.hostname);
  const rule = { hostname, service };
  if (catchAll < 0) return [...filtered, rule, { service: 'http_status:404' }];
  return [...filtered.slice(0, catchAll), rule, ...filtered.slice(catchAll)];
}

export class CloudflareClient {
  private readonly connection: CloudflareConnection;
  private readonly fetcher: typeof fetch;
  constructor(connection: CloudflareConnection, fetcher: typeof fetch = fetch) {
    this.connection = connection;
    this.fetcher = fetcher;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.connection.apiToken}`, 'content-type': 'application/json', ...init.headers },
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(502, 'cloudflare_unavailable', 'Cloudflare could not be reached. Try again.');
    }
    const body = await response.json().catch(() => null) as Envelope<T> | null;
    if (!response.ok || !body?.success) {
      const message = body?.errors?.map((e) => e.message).filter(Boolean).join('; ');
      throw new HttpError(response.status === 401 || response.status === 403 ? 403 : 502, 'cloudflare_error', message || `Cloudflare rejected the request (${response.status}).`);
    }
    return body.result;
  }

  async verify(): Promise<void> { await this.request('/user/tokens/verify'); }
  async zones(): Promise<CloudflareZone[]> { return this.request(`/zones?account.id=${encodeURIComponent(this.connection.accountId)}&per_page=50`); }
  async addZone(name: string): Promise<CloudflareZone> {
    return this.request('/zones', { method: 'POST', body: JSON.stringify({ name: normalizeDomain(name), account: { id: this.connection.accountId }, type: 'full', jump_start: true }) });
  }
  async records(zoneId: string): Promise<DnsRecord[]> { return this.request(`/zones/${zoneId}/dns_records?per_page=100&order=name&direction=asc`); }
  async createRecord(zoneId: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    return this.request(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(record) });
  }
  async updateRecord(zoneId: string, recordId: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    return this.request(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'PUT', body: JSON.stringify(record) });
  }
  async deleteRecord(zoneId: string, recordId: string): Promise<{ id: string }> {
    return this.request(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  }
  async publishHostname(zone: CloudflareZone, hostnameInput: string, serviceInput?: string): Promise<{ hostname: string; record: DnsRecord }> {
    const tunnelId = this.connection.tunnelId;
    if (!tunnelId) throw new HttpError(409, 'tunnel_not_configured', 'Add a Cloudflare tunnel ID in the connection settings first.');
    const hostname = normalizeHostname(hostnameInput, zone.name);
    const service = serviceInput?.trim() || this.connection.defaultService || 'http://web:80';
    const current = await this.request<{ config?: { ingress?: IngressRule[]; 'warp-routing'?: Record<string, unknown> } }>(`/accounts/${this.connection.accountId}/cfd_tunnel/${tunnelId}/configurations`);
    const config = current.config ?? {};
    const ingress = mergeTunnelIngress(config.ingress ?? [], hostname, service);
    await this.request(`/accounts/${this.connection.accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: 'PUT', body: JSON.stringify({ config: { ...config, ingress } }),
    });
    const existing = (await this.records(zone.id)).find((record) => record.name.toLowerCase() === hostname);
    if (existing && existing.type !== 'CNAME') throw new HttpError(409, 'dns_conflict', `${hostname} already has a ${existing.type} record. Remove it before publishing the tunnel hostname.`);
    const value = { type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment: 'Managed by Darkspace' };
    const record = existing ? await this.updateRecord(zone.id, existing.id, value) : await this.createRecord(zone.id, value);
    return { hostname, record };
  }
}
