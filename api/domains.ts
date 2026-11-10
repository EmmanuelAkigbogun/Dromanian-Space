import { z } from 'zod';
import { authenticate } from '../server/database.js';
import { CloudflareClient, DEFAULT_TUNNEL_SERVICE, normalizeRecordName } from '../server/cloudflare.js';
import { removeCloudflareConnection, saveCloudflareConnection, savedCloudflareConnection } from '../server/cloudflare-secrets.js';
import { errorResponse, HttpError, json, readJson } from '../server/http.js';

const cfId = z.string().regex(/^[a-f0-9]{32}$/i, 'Invalid Cloudflare identifier');
const recordSchema = z.object({
  type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA']),
  name: z.string().trim().min(1).max(253),
  content: z.string().trim().min(1).max(4096),
  ttl: z.number().int().min(1).max(86400).default(1),
  proxied: z.boolean().default(false),
  priority: z.number().int().min(0).max(65535).optional(),
  comment: z.string().trim().max(500).optional(),
});

function requireAdmin(user: Awaited<ReturnType<typeof authenticate>>): void {
  if (user.appMetadata?.platform_admin !== true) throw new HttpError(403, 'forbidden', 'Only the platform administrator can manage domains.');
}

async function connection() {
  const value = await savedCloudflareConnection();
  if (!value) throw new HttpError(409, 'not_configured', 'Connect Cloudflare first.');
  return value;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request); requireAdmin(user);
    const saved = await savedCloudflareConnection();
    if (!saved) return json({ allowed: true, configured: false, zones: [] });
    const client = new CloudflareClient(saved);
    const url = new URL(request.url);
    const zoneId = url.searchParams.get('zone_id');
    if (zoneId) {
      if (!cfId.safeParse(zoneId).success) throw new HttpError(400, 'invalid_request', 'Invalid zone ID.');
      return json({ records: await client.records(zoneId) });
    }
    return json({ allowed: true, configured: true, account_id: saved.accountId, tunnel_id: saved.tunnelId ?? null, default_service: saved.defaultService ?? DEFAULT_TUNNEL_SERVICE, zones: await client.zones() });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request); requireAdmin(user);
    const raw = await readJson(request, z.object({ action: z.string().min(1) }).passthrough());
    if (raw.action === 'configure') {
      const body = z.object({ action: z.literal('configure'), api_token: z.string().trim().min(20).max(1000), account_id: cfId, tunnel_id: cfId.optional().or(z.literal('')), default_service: z.string().trim().max(500).optional() }).parse(raw);
      const value = { apiToken: body.api_token, accountId: body.account_id, tunnelId: body.tunnel_id || undefined, defaultService: body.default_service || DEFAULT_TUNNEL_SERVICE };
      await new CloudflareClient(value).verify();
      await saveCloudflareConnection(value);
      return json({ configured: true });
    }
    if (raw.action === 'disconnect') { await removeCloudflareConnection(); return json({ configured: false }); }
    const value = await connection(); const client = new CloudflareClient(value);
    if (raw.action === 'add_domain') {
      const body = z.object({ action: z.literal('add_domain'), domain: z.string() }).parse(raw);
      return json({ zone: await client.addZone(body.domain) }, 201);
    }
    const zoneId = cfId.parse(raw.zone_id);
    const zones = await client.zones();
    const zone = zones.find((item) => item.id === zoneId);
    if (!zone) throw new HttpError(404, 'not_found', 'That zone is not in the connected Cloudflare account.');
    if (raw.action === 'create_record') {
      const body = z.object({ action: z.literal('create_record'), zone_id: cfId, record: recordSchema }).parse(raw);
      const record = {
        ...body.record,
        name: normalizeRecordName(body.record.name, zone.name),
        proxied: ['A', 'AAAA', 'CNAME'].includes(body.record.type) && body.record.proxied,
        ...(body.record.type === 'MX' && body.record.priority === undefined ? { priority: 10 } : {}),
      };
      return json({ record: await client.createRecord(zoneId, record) }, 201);
    }
    if (raw.action === 'update_record') {
      const body = z.object({ action: z.literal('update_record'), zone_id: cfId, record_id: cfId, record: recordSchema }).parse(raw);
      const record = {
        ...body.record,
        name: normalizeRecordName(body.record.name, zone.name),
        proxied: ['A', 'AAAA', 'CNAME'].includes(body.record.type) && body.record.proxied,
        ...(body.record.type === 'MX' && body.record.priority === undefined ? { priority: 10 } : {}),
      };
      return json({ record: await client.updateRecord(zoneId, body.record_id, record) });
    }
    if (raw.action === 'delete_record') {
      const body = z.object({ action: z.literal('delete_record'), zone_id: cfId, record_id: cfId }).parse(raw);
      await client.deleteRecord(zoneId, body.record_id); return json({ deleted: true });
    }
    if (raw.action === 'publish_hostname') {
      const body = z.object({ action: z.literal('publish_hostname'), zone_id: cfId, hostname: z.string(), service: z.string().optional() }).parse(raw);
      return json(await client.publishHostname(zone, body.hostname, body.service));
    }
    throw new HttpError(400, 'invalid_action', 'Unknown domain action.');
  } catch (error) { return errorResponse(error); }
}
