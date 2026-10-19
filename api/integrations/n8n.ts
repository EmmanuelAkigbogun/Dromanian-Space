// /api/integrations/n8n/runs — signed requests from an n8n workflow (or any
// client holding an automation key). See server/integrations/n8n.ts for the
// signature scheme and docs/AUTOMATION.md for workflow examples.
//   POST {agent, message, request_id, callback_url?} -> 202 {request_id, run_id, status, reused}
//        Repeating a request_id returns the original run (no duplicate work).
//   GET  ?run_id=…  -> current status and, once finished, the output.
import { z } from 'zod';
import { enqueueRun } from '../../server/agents/tail.js';
import { errorResponse, HttpError, json } from '../../server/http.js';
import { checkCallbackUrl, runSummary, verifySignedRequest } from '../../server/integrations/n8n.js';
import { rpc, serviceClient } from '../../server/supabase.js';

const MAX_BODY = 64 * 1024;

const StartBody = z.object({
  agent: z.string().trim().min(3).max(41),
  message: z.string().trim().min(1).max(20000),
  request_id: z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/, 'request_id may contain letters, digits and . _ : -'),
  callback_url: z.string().url().max(2000).nullish(),
});

async function rawBody(request: Request): Promise<string> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body is too large.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body is too large.');
  return text;
}

interface Started {
  request_id: string;
  run_id: string | null;
  status: string;
  reused: boolean;
  workspace_id?: string;
  principal_id?: string;
  error?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  let keyId: string | null = null;
  let requestKey: string | null = null;
  try {
    const text = await rawBody(request);
    const key = await verifySignedRequest(request, text);
    keyId = key.id;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body must be JSON.');
    }
    const parsed = StartBody.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
    }
    const body = parsed.data;
    requestKey = body.request_id;
    const callback = checkCallbackUrl(body.callback_url);
    const started = await rpc<Started>('automation_start_run', {
      p_key_id: key.id,
      p_request_key: body.request_id,
      p_agent_handle: body.agent,
      p_message: body.message,
      p_callback_url: callback,
    });
    if (started.run_id && (!started.reused || started.status === 'queued')) {
      await enqueueRun(started.run_id, key.workspace_id, key.principal_id);
    }
    return json(
      { request_id: body.request_id, run_id: started.run_id, status: started.status, reused: started.reused, error: started.error ?? null },
      started.status === 'rejected' ? 409 : 202,
    );
  } catch (err) {
    // Permanent refusals are kept in the admin's execution log; limits
    // (429/409) are not, so the same request_id can be retried later.
    if (keyId && requestKey && err instanceof HttpError && (err.status === 400 || err.status === 403)) {
      await rpc('automation_log_rejection', { p_key_id: keyId, p_request_key: requestKey, p_error: err.message }).catch(() => undefined);
    }
    return errorResponse(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const key = await verifySignedRequest(request, '');
    const runId = new URL(request.url).searchParams.get('run_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new HttpError(400, 'invalid_request', 'run_id is required.');
    // Only runs started with this key are visible to it.
    const { data } = await serviceClient().from('automation_requests').select('request_key').eq('key_id', key.id).eq('run_id', runId).maybeSingle();
    if (!data) throw new HttpError(404, 'not_found', 'Run not found.');
    const summary = await runSummary(runId);
    if (!summary) throw new HttpError(404, 'not_found', 'Run not found.');
    return json({ request_id: data.request_key, ...summary });
  } catch (err) {
    return errorResponse(err);
  }
}
