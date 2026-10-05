// Adapts Node's http server to the web-standard handlers in api/, with
// request IDs, a body size limit and structured access logs.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { errorResponse, HttpError, methodNotAllowed } from './http.js';
import { log } from './log.js';
import { ROUTES } from './routes.js';

const MAX_BODY = 256 * 1024;

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
  try {
    const route = ROUTES[url.pathname];
    const method = (req.method ?? 'GET') as 'GET' | 'POST';
    const handler = route?.[method];
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
      if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'Request is too large.');
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
    log.info('request', { request_id: requestId, method: req.method, path: url.pathname, status, ms: Date.now() - started });
  }
}
