// crm.find_emails: finds work emails for CRM contacts that have none, company
// by company (see server/email-finder.ts). Runs as the person who started it,
// so row-level security decides which contacts it may read and update. Each
// contact is saved as soon as it is done; a retried job skips contacts it has
// already handled.
import { asAuthenticated, type AuthUser } from '../database.js';
import { log } from '../log.js';
import { domainOf, EMAIL_STATUS, findEmailsForDomain, type EmailResult, type FinderContact } from '../email-finder.js';
import { PermanentJobError, type JobHandler } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_CONTACTS_PER_JOB = 1000;

interface Row { id: string; name: string; website: string | null; company_email: string | null }

export const handleCrmFindEmails: JobHandler = async (job, ctx) => {
  const workspaceId = job.workspace_id;
  const userId = job.principal_id;
  const clientId = job.payload.client_id == null ? null : String(job.payload.client_id);
  const ids = Array.isArray(job.payload.contact_ids) ? job.payload.contact_ids.map(String) : null;
  if (!workspaceId || !userId) throw new PermanentJobError('Job has no workspace or principal');
  if (clientId !== null && !UUID.test(clientId)) throw new PermanentJobError('Bad client_id');
  if (ids && !ids.every((id) => UUID.test(id))) throw new PermanentJobError('Bad contact_ids');
  const user: AuthUser = { id: userId, email: null };

  const rows = await asAuthenticated(user, async (client) => (await client.query<Row>(
    `SELECT c.id, c.name, co.domain AS website, co.email AS company_email
       FROM public.crm_contacts c
       LEFT JOIN public.crm_companies co ON co.id = c.company_id
      WHERE c.workspace_id = $1
        AND c.client_id IS NOT DISTINCT FROM $2::uuid
        AND c.email IS NULL
        AND ($3::uuid[] IS NULL OR c.id = ANY($3::uuid[]))
        AND coalesce(c.custom->>'email_job', '') <> $4
        AND (c.owner_id = auth.uid() OR c.created_by = auth.uid() OR public.user_is_workspace_admin(c.workspace_id, auth.uid()))
      ORDER BY co.domain NULLS LAST, c.name
      LIMIT $5`,
    [workspaceId, clientId, ids, job.id, MAX_CONTACTS_PER_JOB])).rows);

  const counts: Record<string, number> = {};
  const save = async (contact: FinderContact, result: EmailResult) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    const custom = { email_status: result.status, email_evidence: result.evidence.slice(0, 500), email_checked_at: new Date().toISOString(), email_job: job.id };
    await asAuthenticated(user, async (client) => {
      try {
        await client.query('SAVEPOINT set_email');
        await client.query(
          `UPDATE public.crm_contacts SET email = coalesce(email, $2), custom = custom || $3::jsonb WHERE id = $1 AND email IS NULL`,
          [contact.id, result.email, JSON.stringify(custom)]);
      } catch (err) {
        // The address already belongs to another contact in this workspace.
        if ((err as { code?: string }).code !== '23505') throw err;
        await client.query('ROLLBACK TO SAVEPOINT set_email');
        await client.query(
          `UPDATE public.crm_contacts SET custom = custom || $2::jsonb WHERE id = $1 AND email IS NULL`,
          [contact.id, JSON.stringify({ ...custom, email_evidence: `${result.email} is already on another contact. ${custom.email_evidence}`.slice(0, 500) })]);
      }
    });
  };

  const byDomain = new Map<string, FinderContact[]>();
  for (const r of rows) {
    const domain = domainOf(r.website) ?? (r.company_email?.includes('@') ? domainOf(r.company_email.split('@')[1]) : null);
    if (!domain) {
      await save(r, { email: null, status: EMAIL_STATUS.notFound, evidence: 'The company has no website in the CRM' });
      continue;
    }
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), { id: r.id, name: r.name }]);
  }

  for (const [domain, contacts] of byDomain) {
    if (ctx.signal.aborted) throw new Error('Email search interrupted; it will resume where it stopped');
    try {
      await findEmailsForDomain(domain, contacts, { signal: ctx.signal, onResult: save });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'email_verifier_rejected') throw new PermanentJobError('The email verifier rejected its deployment credential.');
      if (ctx.signal.aborted) throw new Error('Email search interrupted; it will resume where it stopped');
      log.warn('email search failed for domain', { domain, error: message });
    }
  }
  return { contacts: rows.length, domains: byDomain.size, ...counts };
};
