// Optional n8n integration: signed requests in, signed callbacks out.
//
// Signature (both directions): HMAC-SHA256 with the automation key's secret
// over `${timestamp}.${METHOD}.${path_and_query}.${raw_body}`, sent as
//   x-dromanian-key: <key id>          (requests to this API only)
//   x-dromanian-timestamp: <unix seconds>
//   x-dromanian-signature: v1=<hex digest>
// Requests older than five minutes are rejected. Callbacks are only sent to
// the host configured in N8N_BASE_URL, so this server never makes requests to
// arbitrary addresses on a caller's behalf.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { HttpError } from '../http.js';
import { log } from '../log.js';
import { rpc, serviceClient } from '../supabase.js';
import { PermanentJobError, type JobHandler } from '../jobs/types.js';

export const MAX_SKEW_SECONDS = 300;
const CALLBACK_TIMEOUT_MS = 15_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'awaiting_approval']);

export interface AutomationKey {
  id: string;
  workspace_id: string;
  principal_id: string;
  secret: string;
  allowed_agent_ids: string[];
  active: boolean;
}

export function sign(secret: string, timestamp: string, method: string, pathAndQuery: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${method.toUpperCase()}.${pathAndQuery}.${body}`).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Verifies a signed request and returns its key. Throws 401 on any mismatch. */
export async function verifySignedRequest(request: Request, body: string, now = Date.now()): Promise<AutomationKey> {
  const keyId = request.headers.get('x-dromanian-key') ?? '';
  const timestamp = request.headers.get('x-dromanian-timestamp') ?? '';
  const signature = request.headers.get('x-dromanian-signature') ?? '';
  const reject = (why: string) => {
    log.warn('automation request rejected', { reason: why, key_id: /^[0-9a-f-]{36}$/i.test(keyId) ? keyId : null });
    return new HttpError(401, 'unauthenticated', 'The request signature is missing, expired or invalid.');
  };
  if (!/^[0-9a-f-]{36}$/i.test(keyId) || !/^\d{9,11}$/.test(timestamp) || !signature) throw reject('missing headers');
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) throw reject('timestamp outside window');
  const key = await rpc<AutomationKey | null>('automation_key_for', { p_key_id: keyId });
  if (!key) throw reject('unknown key');
  const url = new URL(request.url);
  const expected = sign(key.secret, timestamp, request.method, url.pathname + url.search, body);
  if (!safeEqual(expected, signature)) throw reject('bad signature');
  if (!key.active) throw new HttpError(403, 'forbidden', 'This automation key is revoked or its owner is no longer a workspace member.');
  return key;
}

/** Callbacks may only target the configured n8n host. */
export function checkCallbackUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = env().n8nBaseUrl;
  if (!base) throw new HttpError(400, 'invalid_request', 'Callbacks are disabled: N8N_BASE_URL is not configured on the server.');
  let url: URL;
  let allowed: URL;
  try {
    url = new URL(raw);
    allowed = new URL(base);
  } catch {
    throw new HttpError(400, 'invalid_request', 'callback_url must be an absolute URL.');
  }
  if (url.host !== allowed.host || url.protocol !== allowed.protocol || url.username || url.password) {
    throw new HttpError(400, 'invalid_request', `callback_url must be on ${allowed.protocol}//${allowed.host}.`);
  }
  if (raw.length > 2000) throw new HttpError(400, 'invalid_request', 'callback_url is too long.');
  return url.toString();
}

export interface RunSummary {
  run_id: string;
  status: string;
  agent: string | null;
  output: string | null;
  error_code: string | null;
  error_message: string | null;
  finished_at: string | null;
}

export async function runSummary(runId: string): Promise<RunSummary | null> {
  const db = serviceClient();
  const { data: run } = await db
    .from('agent_runs')
    .select('id, status, agent_id, output_message_id, error_code, error_message, finished_at')
    .eq('id', runId)
    .maybeSingle();
  if (!run) return null;
  const [{ data: msg }, { data: agent }] = await Promise.all([
    db.from('agent_messages').select('content').eq('id', run.output_message_id).maybeSingle(),
    db.from('workspace_agents').select('handle').eq('id', run.agent_id).maybeSingle(),
  ]);
  const done = TERMINAL.has(run.status as string);
  return {
    run_id: run.id as string,
    status: run.status as string,
    agent: (agent?.handle as string | undefined) ?? null,
    output: done ? ((msg?.content as string | undefined) ?? '') : null,
    error_code: (run.error_code as string | null) ?? null,
    error_message: (run.error_message as string | null) ?? null,
    finished_at: (run.finished_at as string | null) ?? null,
  };
}

interface CallbackTarget {
  request_id: string;
  request_key: string;
  key_id: string;
  workspace_id: string;
  callback_url: string | null;
  status: string;
}

/** After a run finishes: queue its callback (idempotent per request). */
export async function queueCallbackForRun(runId: string): Promise<void> {
  const target = await rpc<CallbackTarget | null>('automation_callback_for_run', { p_run_id: runId });
  if (!target || target.status !== 'accepted') return;
  if (!target.callback_url) {
    await rpc('automation_record_delivery', { p_request_id: target.request_id, p_status: 'no_callback' });
    return;
  }
  await rpc('enqueue_job', {
    p_kind: 'automation.callback',
    p_workspace_id: target.workspace_id,
    p_principal_id: null,
    p_payload: { request_id: target.request_id, run_id: runId },
    p_idempotency_key: `automation.callback:${target.request_id}`,
    p_max_attempts: 6,
  });
}

/** Job: deliver a signed callback with a timeout; retried with backoff by the queue. */
export const handleAutomationCallback: JobHandler = async (job, ctx) => {
  const runId = String(job.payload.run_id ?? '');
  const requestId = String(job.payload.request_id ?? '');
  const target = await rpc<CallbackTarget | null>('automation_callback_for_run', { p_run_id: runId });
  if (!target || target.request_id !== requestId) throw new PermanentJobError('Automation request not found');
  if (target.status !== 'accepted') return { skipped: target.status };
  const summary = await runSummary(runId);
  if (!summary) throw new PermanentJobError('Run not found');
  if (!TERMINAL.has(summary.status)) throw new Error('Run has not finished yet');
  const key = await rpc<AutomationKey | null>('automation_key_for', { p_key_id: target.key_id });
  if (!key) throw new PermanentJobError('Automation key not found');

  const fail = async (message: string, permanent: boolean) => {
    if (permanent || ctx.isLastAttempt) {
      await rpc('automation_record_delivery', { p_request_id: requestId, p_status: 'delivery_failed', p_error: message });
    }
    throw permanent ? new PermanentJobError(message) : new Error(message);
  };

  let url: string;
  try {
    url = checkCallbackUrl(target.callback_url)!;
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Invalid callback URL', true);
  }
  const body = JSON.stringify({ request_id: target.request_key, ...summary });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const parsed = new URL(url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dromanian-timestamp': timestamp,
        'x-dromanian-signature': sign(key.secret, timestamp, 'POST', parsed.pathname + parsed.search, body),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CALLBACK_TIMEOUT_MS)]),
    });
  } catch (err) {
    return fail(`Callback request failed: ${err instanceof Error ? err.message : String(err)}`, false);
  }
  if (!response.ok) {
    // 4xx other than 408/429 will not succeed on retry.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
    return fail(`Callback returned HTTP ${response.status}`, permanent);
  }
  await rpc('automation_record_delivery', { p_request_id: requestId, p_status: 'delivered' });
  return { delivered: true, status: response.status };
};
