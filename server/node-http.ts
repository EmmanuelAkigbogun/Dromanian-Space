// Adapts Node's http server to the web-standard handlers in api/, with
// request IDs, a body size limit and structured access logs.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { errorResponse, HttpError, json, methodNotAllowed } from './http.js';
import { log } from './log.js';
import { clientAddress, limitFor, RateLimiter } from './rate-limit.js';
import { ROUTES } from './routes.js';
import type { ApiMethod, Handler } from './routes.js';
import { proxyDatabase } from '../api/data.js';
import * as storage from '../api/storage.js';

const MAX_BODY = 256 * 1024;
const MAX_STORAGE_BODY = Number(process.env.STORAGE_MAX_FILE_BYTES ?? 50 * 1024 * 1024) + 1024;
const limiter = new RateLimiter();

function dynamicRoute(pathname: string, method: ApiMethod): Handler | null {
  if (pathname.startsWith('/api/db/')) {
    const suffix = pathname.slice('/api/db/'.length);
    return (request) => proxyDatabase(request, suffix);
  }
  if (pathname.startsWith('/api/storage/object/') && method === 'POST') {
    const suffix = pathname.slice('/api/storage/object/'.length);
    return (request) => storage.upload(request, suffix);
  }
  if (pathname.startsWith('/api/storage/list/') && method === 'POST') {
    const suffix = pathname.slice('/api/storage/list/'.length);
    return (request) => storage.list(request, suffix);
  }
  if (pathname.startsWith('/api/storage/remove/') && method === 'POST') {
    const suffix = pathname.slice('/api/storage/remove/'.length);
    return (request) => storage.remove(request, suffix);
  }
  if (pathname.startsWith('/api/storage/sign/') && method === 'POST') {
    const suffix = pathname.slice('/api/storage/sign/'.length);
    return (request) => storage.sign(request, suffix);
  }
  if (pathname.startsWith('/api/storage/file/') && (method === 'GET' || method === 'HEAD')) {
    const suffix = pathname.slice('/api/storage/file/'.length);
    return (request) => storage.file(request, suffix);
  }
  return null;
}

async function send(res: ServerResponse, response: Response, requestId: string) {
  const headers = Object.fromEntries(response.headers);
  headers['x-request-id'] = requestId;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as unknown as NodeReadableStream);
  res.on('close', () => body.destroy());
  body.pipe(res);
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID();
  const started = Date.now();
  const url = new URL(req.url ?? '/', 'http://localhost');
  let status = 500;
  const client = clientAddress(req.headers['x-forwarded-for'] as string | undefined, req.socket.remoteAddress);
  try {
    const limit = limitFor(req.method ?? 'GET', url.pathname);
    const retryAfter = limit ? limiter.hit(`${limit.bucket}:${client}`, limit.limit) : 0;
    if (retryAfter > 0) {
      const r = json({ error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' } }, 429, { 'retry-after': String(retryAfter) });
      status = r.status;
      await send(res, r, requestId);
      return;
    }
    const route = ROUTES[url.pathname];
    const method = (req.method ?? 'GET') as ApiMethod;
    const handler = route?.[method] ?? dynamicRoute(url.pathname, method);
    if (!handler) {
      const r = route ? methodNotAllowed() : new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), { status: 404 });
      status = r.status;
      await send(res, r, requestId);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      const limit = url.pathname.startsWith('/api/storage/object/') ? MAX_STORAGE_BODY : MAX_BODY;
      if (size > limit) throw new HttpError(413, 'too_large', 'Request is too large.');
      chunks.push(chunk as Buffer);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, { method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handler(request);
    status = response.status;
    await send(res, response, requestId);
  } catch (err) {
    const response = errorResponse(err);
    status = response.status;
    await send(res, response, requestId);
  } finally {
    log.info('request', { request_id: requestId, method: req.method, path: url.pathname, status, ms: Date.now() - started, client });
  }
}
