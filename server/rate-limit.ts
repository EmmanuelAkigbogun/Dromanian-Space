// Per-session request limits for the API (fixed one-minute windows, in
// memory). Authenticated users behind the same office gateway must not consume
// one shared IP bucket. Anonymous traffic still falls back to the client IP.

import { createHash } from 'node:crypto';

export interface Limit {
  /** Requests per minute. */
  perMinute: number;
}

const general = Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 600);
const agentStarts = Number(process.env.API_AGENT_RATE_LIMIT_PER_MINUTE ?? 30);

/** Bucket and limit for a request, or null when it is not limited. */
export function limitFor(method: string, path: string): { bucket: string; limit: number } | null {
  if (path === '/api/health' || path === '/api/ready') return null;
  if (method === 'POST' && (path.startsWith('/api/agents/') || path.startsWith('/api/integrations/'))) {
    return { bucket: 'start', limit: agentStarts };
  }
  return { bucket: 'general', limit: general };
}

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  /** Returns seconds until the window resets when the request is over the limit, else 0. */
  hit(key: string, limit: number, now = Date.now()): number {
    if (limit <= 0) return 0;
    this.sweep(now);
    const windowStart = now - (now % 60_000);
    const w = this.windows.get(key);
    if (!w || w.start !== windowStart) {
      this.windows.set(key, { start: windowStart, count: 1 });
      return 0;
    }
    w.count++;
    return w.count > limit ? Math.ceil((windowStart + 60_000 - now) / 1000) : 0;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const current = now - (now % 60_000);
    for (const [k, w] of this.windows) if (w.start < current) this.windows.delete(k);
  }
}

const TRUSTED_PROXY_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? 2));

/**
 * Client address. Each trusted proxy appends the address it received the
 * request from: Coolify's Traefik appends the client, the web container's
 * Nginx appends Traefik. Entries further left were supplied by the client and
 * are ignored, so a forged X-Forwarded-For cannot dodge the limit.
 */
export function clientAddress(forwardedFor: string | undefined, socketAddress: string | undefined, hops = TRUSTED_PROXY_HOPS): string {
  const chain = (forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const client = chain.length ? chain[Math.max(0, chain.length - hops)] : undefined;
  return (client || socketAddress || 'unknown').slice(0, 64);
}

/**
 * Stable, privacy-preserving limiter subject. The opaque HttpOnly session is
 * already present on all same-origin app requests, and unlike an IP address it
 * identifies one signed-in browser even when many users share a gateway.
 */
export function rateLimitSubject(cookieHeader: string | undefined, client: string): string {
  const session = (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('dromanian_session='))
    ?.slice('dromanian_session='.length);
  if (!session) return `ip:${client}`;
  const digest = createHash('sha256').update(session).digest('hex').slice(0, 32);
  return `session:${digest}`;
}
