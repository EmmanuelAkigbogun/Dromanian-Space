import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { defineTool, quoteData, type ToolOutput } from './types.js';

const SCRAPE_TIMEOUT_MS = 30_000;
const DNS_LOOKUP_TIMEOUT_MS = 3_000;
const READINESS_TIMEOUT_MS = 2_500;
const READINESS_CACHE_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_CHARS = 20_000;

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv6');

export type HostResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const resolveHostname: HostResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizedHostname(address);
  const family = isIP(normalized);
  if (family === 4) return blockedAddresses.check(normalized, 'ipv4');
  if (family === 6) {
    // IPv4-mapped literals can otherwise bypass the IPv4 ranges above. There
    // is no legitimate need for agents to use this alternate spelling.
    if (normalized.startsWith('::ffff:')) return true;
    return blockedAddresses.check(normalized, 'ipv6');
  }
  return true;
}

/**
 * Defense in depth around Crawl4AI's own resolve-and-pin SSRF protection.
 * Every resolved address must be public so a mixed DNS answer cannot slip an
 * internal target through, and the sidecar independently validates it again.
 */
async function resolveWithTimeout(
  resolver: HostResolver,
  hostname: string,
  timeoutMs: number,
): Promise<ReadonlyArray<{ address: string; family: number }>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(hostname),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('dns_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function assertPublicWebUrl(
  raw: string,
  resolver: HostResolver = resolveHostname,
  dnsTimeoutMs = DNS_LOOKUP_TIMEOUT_MS,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('target_rejected');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('target_rejected');
  }

  const hostname = normalizedHostname(url.hostname);
  if (
    !hostname
    || (!hostname.includes('.') && isIP(hostname) === 0)
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa')
    || hostname.endsWith('.test')
    || hostname.endsWith('.invalid')
  ) throw new Error('target_rejected');

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('target_rejected');
  } else {
    let addresses: ReadonlyArray<{ address: string; family: number }>;
    try {
      addresses = await resolveWithTimeout(resolver, hostname, dnsTimeoutMs);
    } catch {
      throw new Error('target_rejected');
    }
    if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
      throw new Error('target_rejected');
    }
  }

  url.hash = '';
  return url;
}

interface BrowserScraperConnection {
  baseUrl: string;
  token: string;
}

function tokenFromFile(path: string | undefined): string {
  if (!path?.trim()) return '';
  try {
    return readFileSync(path.trim(), 'utf8').trim();
  } catch {
    return '';
  }
}

export function browserScraperConnection(source: NodeJS.ProcessEnv = process.env): BrowserScraperConnection | null {
  const rawBaseUrl = source.CRAWL4AI_URL?.trim();
  const token = source.CRAWL4AI_API_TOKEN?.trim() || tokenFromFile(source.CRAWL4AI_API_TOKEN_FILE);
  if (!rawBaseUrl || !token) return null;
  try {
    const url = new URL(rawBaseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return { baseUrl: url.toString().replace(/\/$/, ''), token };
  } catch {
    return null;
  }
}

export function browserScraperConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
  return browserScraperConnection(source) !== null;
}

export interface BrowserScraperHealth {
  available: boolean;
  reason?: string;
}

interface CachedReadiness {
  key: string;
  expiresAt: number;
  probe: Promise<BrowserScraperHealth>;
}

let readinessCache: CachedReadiness | null = null;

function readinessKey(connection: BrowserScraperConnection): string {
  const tokenHash = createHash('sha256').update(connection.token).digest('hex');
  return `${connection.baseUrl}:${tokenHash}`;
}

async function probeBrowserScraper(connection: BrowserScraperConnection): Promise<BrowserScraperHealth> {
  try {
    // `/health` is intentionally public in Crawl4AI. `/schema` crosses the auth
    // middleware, so this verifies reachability, the mounted token and the API
    // contract without starting a browser or fetching an external page.
    const response = await fetch(`${connection.baseUrl}/schema`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${connection.token}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      return { available: false, reason: 'The private browser scraper rejected its deployment credential.' };
    }
    return response.ok
      ? { available: true }
      : { available: false, reason: `The private browser scraper readiness check returned HTTP ${response.status}.` };
  } catch {
    return { available: false, reason: 'The private browser scraper is configured but cannot be reached.' };
  }
}

/**
 * Authenticated, cached readiness for status pages and run admission. The
 * cache also coalesces concurrent probes so opening several clients does not
 * turn readiness into load on the scraper.
 */
export async function browserScraperHealth(
  source: NodeJS.ProcessEnv = process.env,
  options: { fresh?: boolean } = {},
): Promise<BrowserScraperHealth> {
  const connection = browserScraperConnection(source);
  if (!connection) return { available: false, reason: 'The private browser scraper is not configured on this deployment.' };
  const key = readinessKey(connection);
  const now = Date.now();
  if (!options.fresh && readinessCache?.key === key && readinessCache.expiresAt > now) return readinessCache.probe;
  const probe = probeBrowserScraper(connection);
  readinessCache = { key, expiresAt: now + READINESS_CACHE_MS, probe };
  return probe;
}

/** Explicit name for callers deciding whether a run may receive the tool. */
export const browserScraperReadiness = browserScraperHealth;

/** Test/deployment helper; production callers normally rely on the short TTL. */
export function resetBrowserScraperReadinessCache(): void {
  readinessCache = null;
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error('response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function failed(error: string): ToolOutput {
  const messages: Record<string, string> = {
    target_rejected: 'The browser scraper refused that address because it is not a public HTTP(S) page.',
    not_configured: 'The private browser scraper is not configured on this deployment.',
    timeout: 'The page took too long to load in the browser scraper.',
    upstream_error: 'The browser scraper could not load that page.',
    authentication_failed: 'The browser scraper deployment credential was rejected.',
    rate_limited: 'The browser scraper is busy. Try again shortly.',
    service_unavailable: 'The browser scraper is temporarily unavailable.',
    redirect_rejected: 'The browser scraper returned an unexpected redirect.',
    response_too_large: 'The page exceeded the browser scraper response limit.',
    invalid_response: 'The browser scraper returned an invalid page result.',
  };
  return {
    content: messages[error] ?? messages.upstream_error,
    summary: { error },
    status: 'failed',
    isError: true,
  };
}

function isRedirectFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (/redirect/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

export const browserScrape = defineTool({
  name: 'browser_scrape',
  description: 'Load one public HTTP(S) page in the private browser and return its rendered content as untrusted Markdown. Use after finding a URL; it cannot log in, run supplied scripts, or access local/private addresses.',
  schema: z.object({
    url: z.string().url().max(2_048),
    max_chars: z.number().int().min(1_000).max(40_000).optional(),
  }),
  label: (input) => {
    try {
      return `Reading ${new URL(input.url).hostname}`;
    } catch {
      return 'Reading public web page';
    }
  },
  async run(ctx, input) {
    let url: URL;
    try {
      url = await assertPublicWebUrl(input.url);
    } catch {
      return failed('target_rejected');
    }

    const connection = browserScraperConnection();
    if (!connection) return failed('not_configured');

    try {
      const response = await fetch(`${connection.baseUrl}/md`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
        },
        // `fit` asks Crawl4AI for its cleaned, relevance-filtered Markdown.
        // No request-supplied browser configuration crosses this boundary.
        body: JSON.stringify({ url: url.toString(), f: 'fit' }),
        redirect: 'error',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(SCRAPE_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel();
        if (status === 401 || status === 403) {
          resetBrowserScraperReadinessCache();
          return failed('authentication_failed');
        }
        if (status === 429) return failed('rate_limited');
        if (status === 503) {
          resetBrowserScraperReadinessCache();
          return failed('service_unavailable');
        }
        if (status === 504) {
          resetBrowserScraperReadinessCache();
          return failed('timeout');
        }
        return failed('upstream_error');
      }

      const raw = await readCappedText(response, MAX_RESPONSE_BYTES);
      let result: unknown;
      try {
        result = JSON.parse(raw);
      } catch {
        return failed('invalid_response');
      }
      // FastAPI serializes Crawl4AI's string return value as a JSON string.
      // Accept the older object shape too so an image update cannot silently
      // turn every successful scrape into `invalid_response`.
      const markdown = typeof result === 'string'
        ? result.trim()
        : typeof result === 'object' && result !== null && typeof (result as { markdown?: unknown }).markdown === 'string'
          ? (result as { markdown: string }).markdown.trim()
          : '';
      if (!markdown) return failed('invalid_response');

      const maxChars = input.max_chars ?? DEFAULT_OUTPUT_CHARS;
      const truncated = markdown.length > maxChars;
      const content = truncated ? `${markdown.slice(0, maxChars)}\n\n[Page output truncated by Darkspace.]` : markdown;
      await ctx.recordSource('web', url.toString(), { label: url.hostname });
      return {
        content: quoteData('external_web_page', {
          url: url.toString(),
          fetched_by: 'Crawl4AI',
          trust: 'untrusted',
          truncated: String(truncated),
        }, content),
        summary: { host: url.hostname, characters: content.length, truncated },
      };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      resetBrowserScraperReadinessCache();
      const code = error instanceof Error && error.message === 'response_too_large'
        ? 'response_too_large'
        : isRedirectFailure(error)
          ? 'redirect_rejected'
        : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'timeout'
          : 'upstream_error';
      return failed(code);
    }
  },
});
