// POST /api/crm/find-emails — queues an email search (server/jobs/crm-emails.ts)
// for contacts without an email in one CRM (ours or a client's): the selected
// contacts, or all of them. GET ?job_id= reports its progress to its starter.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { asAuthenticated, authenticate, rpc, serviceClient } from '../server/database.js';
import { browserScraperConfigured } from '../server/agents/tools/browser.js';
import { emailVerifierConnection } from '../server/email-finder.js';
import { errorResponse, HttpError, json, readJson } from '../server/http.js';

const MAX_SELECTED = 300; // keeps the job payload under its 16 KB limit

const Body = z.object({
  workspace_id: z.string().uuid(),
  client_id: z.string().uuid().nullable(),
  contact_ids: z.array(z.string().uuid()).min(1).max(MAX_SELECTED).optional(),
});

export async function findEmails(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, Body);
    const pending = await asAuthenticated(user, async (client) => {
      const member = await client.query('SELECT public.user_is_workspace_member($1::uuid, auth.uid()) AS ok', [body.workspace_id]);
      if (!member.rows[0]?.ok) throw new HttpError(403, 'forbidden', 'You are not a member of this workspace.');
      if (body.client_id) {
        const book = await client.query('SELECT 1 FROM public.crm_companies WHERE id = $1 AND workspace_id = $2 AND is_client', [body.client_id, body.workspace_id]);
        if (!book.rowCount) throw new HttpError(404, 'not_found', 'That client CRM was not found.');
      }
      const result = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM public.crm_contacts c
          WHERE c.workspace_id = $1 AND c.client_id IS NOT DISTINCT FROM $2::uuid AND c.email IS NULL
            AND ($3::uuid[] IS NULL OR c.id = ANY($3::uuid[]))
            AND (c.owner_id = auth.uid() OR c.created_by = auth.uid() OR public.user_is_workspace_admin(c.workspace_id, auth.uid()))`,
        [body.workspace_id, body.client_id, body.contact_ids ?? null]);
      return Number(result.rows[0]?.n ?? 0);
    });
    if (!pending) throw new HttpError(400, 'nothing_to_do', 'Every contact you can edit here already has an email.');

    const scope = body.contact_ids ? [...body.contact_ids].sort().join(',') : 'all';
    const key = createHash('sha256').update(`${user.id}|${body.workspace_id}|${body.client_id}|${scope}|${Math.floor(Date.now() / 60_000)}`).digest('hex');
    const jobId = await rpc<string>('enqueue_job', {
      p_kind: 'crm.find_emails',
      p_workspace_id: body.workspace_id,
      p_principal_id: user.id,
      p_payload: { client_id: body.client_id, ...(body.contact_ids ? { contact_ids: body.contact_ids } : {}) },
      p_idempotency_key: `crm-emails:${key}`,
      p_max_attempts: 3,
    });
    return json({
      job_id: jobId,
      contacts: Math.min(pending, 1000),
      website_search: browserScraperConfigured(),
      mailbox_check: emailVerifierConnection() !== null,
    }, 202);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function findEmailsStatus(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const jobId = new URL(request.url).searchParams.get('job_id') ?? '';
    if (!z.string().uuid().safeParse(jobId).success) throw new HttpError(400, 'invalid', 'Give a job_id.');
    const { data, error } = await serviceClient()
      .from('jobs').select('status, result, last_error, attempts, created_at, finished_at')
      .eq('id', jobId).eq('kind', 'crm.find_emails').eq('principal_id', user.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, 'not_found', 'That email search was not found.');
    return json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
