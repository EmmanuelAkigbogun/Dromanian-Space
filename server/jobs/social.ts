// social.publish: posts one social post to one account, at its scheduled time.
import { databasePool } from '../database.js';
import { log } from '../log.js';
import { decryptSession, encryptSession, inTurn, isPlatform, PLATFORMS, publishWith } from '../social.js';
import { PermanentJobError, type JobHandler } from './types.js';

interface TargetRow {
  id: string;
  status: string;
  account_id: string;
  platform: string;
  account_status: string;
  body: string;
  link: string | null;
  scheduled_at: Date | null;
  post_status: string;
  ciphertext: string | null;
}

export const handleSocialPublish: JobHandler = async (job) => {
  const targetId = String(job.payload.target_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw new PermanentJobError('Job has no target_id');
  const db = databasePool();
  const t = (await db.query<TargetRow>(
    `SELECT t.id, t.status, t.account_id, a.platform, a.status AS account_status, p.body, p.link, p.scheduled_at, p.status AS post_status, s.ciphertext
       FROM public.social_post_targets t
       JOIN public.social_posts p ON p.id = t.post_id
       JOIN public.social_accounts a ON a.id = t.account_id
       LEFT JOIN public.social_account_sessions s ON s.account_id = a.id
      WHERE t.id = $1`, [targetId])).rows[0];
  if (!t || t.status !== 'pending') return { skipped: t ? t.status : 'deleted' };
  // A rescheduled post queues a new job; this one is for the old time.
  const runAt = job.payload.run_at ? new Date(String(job.payload.run_at)) : null;
  if (t.scheduled_at && runAt && Math.abs(t.scheduled_at.getTime() - runAt.getTime()) > 60_000 && t.scheduled_at.getTime() > Date.now()) {
    return { skipped: 'rescheduled' };
  }
  const fail = async (error: string, needsLogin = false) => {
    await db.query(`UPDATE public.social_post_targets SET status = 'failed', error = $2 WHERE id = $1`, [targetId, error.slice(0, 1000)]);
    if (needsLogin) await db.query(`UPDATE public.social_accounts SET status = 'needs_login', last_error = $2 WHERE id = $1`, [t.account_id, error.slice(0, 500)]);
    return { failed: error };
  };
  if (!isPlatform(t.platform)) return fail('This network is not supported.');
  if (!t.ciphertext) return fail(`Log in to this ${PLATFORMS[t.platform].label} account first.`, true);
  if (t.body.length > PLATFORMS[t.platform].maxLength) return fail(`Too long for ${PLATFORMS[t.platform].label} (${t.body.length}/${PLATFORMS[t.platform].maxLength} characters).`);

  await db.query(`UPDATE public.social_post_targets SET status = 'publishing', error = NULL WHERE id = $1`, [targetId]);
  try {
    const platform = t.platform;
    const outcome = await inTurn(() => publishWith(platform, decryptSession(t.ciphertext!), { text: t.body, link: t.link ?? undefined }));
    await db.query(
      `INSERT INTO public.social_account_sessions (account_id, ciphertext, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [t.account_id, encryptSession(outcome.session)]);
    if (!outcome.success) {
      const error = outcome.error ?? 'The network did not accept the post.';
      return fail(error, /auth|log ?in|sign ?in/i.test(error));
    }
    await db.query(`UPDATE public.social_post_targets SET status = 'published', published_at = now(), error = NULL WHERE id = $1`, [targetId]);
    await db.query(`UPDATE public.social_accounts SET last_used_at = now(), status = 'connected', last_error = NULL WHERE id = $1`, [t.account_id]);
    return { published: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('social publish failed', { target_id: targetId, error: message });
    return fail(`Publishing failed: ${message}`);
  }
};
