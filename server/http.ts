import type { z } from 'zod';
import { log } from './log.js';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Shape of errors returned by supabase-js (PostgREST / Postgres). */
export interface DbError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

// Postgres error codes raised deliberately by our functions carry messages
// written for end users; anything else is reported generically.
const DB_STATUS: Record<string, [number, string]> = {
  '42501': [403, 'forbidden'],
  '22023': [400, 'invalid_request'],
  '22P02': [400, 'invalid_request'],
  '23514': [400, 'invalid_request'],
  '53400': [429, 'limit_reached'],
  '55000': [409, 'unavailable'],
  '40001': [409, 'conflict'],
  '23505': [409, 'conflict'],
};

export function dbError(error: DbError, context: string): HttpError {
  const mapped = error.code ? DB_STATUS[error.code] : undefined;
  if (mapped) return new HttpError(mapped[0], mapped[1], error.message);
  log.error('database call failed', { context, code: error.code, error: error.message });
  return new HttpError(500, 'internal', 'Something went wrong. Please try again.');
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message } }, err.status);
  }
  log.error('unhandled error', { error: err instanceof Error ? err : String(err) });
  return json({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } }, 500);
}

/** Reads and validates a JSON body, rejecting oversized payloads early. */
export async function readJson<T extends z.ZodType>(request: Request, schema: T, maxBytes = 64 * 1024): Promise<z.infer<T>> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, 'invalid_request', `${where}${issue?.message ?? 'Invalid request'}`);
  }
  return parsed.data;
}

export function methodNotAllowed(): Response {
  return json({ error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, 405);
}

export interface SseChannel {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Server-sent events response. The producer keeps running if the client goes
 * away (the run is persisted; the client recovers it from the database).
 */
export function sseResponse(start: (channel: SseChannel) => void): Response {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const channel: SseChannel = {
    send(event, data) {
      if (closed || !controllerRef) return;
      try {
        controllerRef.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      try {
        controllerRef?.close();
      } catch {
        /* already closed by the client */
      }
    },
    get closed() {
      return closed;
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          closed = true;
        }
      }, 15000);
      start(channel);
    },
    cancel() {
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
