import { authenticate, jwtForRequest } from '../server/database.js';
import { HttpError } from '../server/http.js';
import { publishDatabaseChange } from '../server/events.js';

const restUrl = process.env.DATABASE_REST_URL?.trim() ?? 'http://rest:3000';
const forwardedResponseHeaders = ['content-type', 'content-range', 'preference-applied', 'location'];

export async function proxyDatabase(request: Request, suffix: string): Promise<Response> {
  const user = await authenticate(request);
  if (!/^(?:rpc\/)?[a-zA-Z_][a-zA-Z0-9_]*$/.test(suffix)) throw new HttpError(404, 'not_found', 'Database resource not found.');
  const source = new URL(request.url);
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'prefer', 'range', 'range-unit']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${jwtForRequest(user)}`);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(`${restUrl}/${suffix}${source.search}`, { method: request.method, headers, body, signal: AbortSignal.timeout(30_000) });
  const responseBody = upstream.status === 204 || request.method === 'HEAD' ? null : await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  for (const name of forwardedResponseHeaders) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (upstream.ok && !suffix.startsWith('rpc/') && ['POST', 'PATCH', 'DELETE'].includes(request.method)) {
    const type = request.method === 'POST' ? 'INSERT' : request.method === 'PATCH' ? 'UPDATE' : 'DELETE';
    let rows: unknown = null;
    try { rows = responseBody?.byteLength ? JSON.parse(Buffer.from(responseBody).toString('utf8')) : null; } catch { /* no representation requested */ }
    publishDatabaseChange(suffix, type, rows);
  }
  return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
}

