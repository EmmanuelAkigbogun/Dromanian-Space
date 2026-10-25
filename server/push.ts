// Web Push for task notifications. Browsers subscribe through /api/push; the
// notifications trigger queues a notification.push job for people with a
// subscription, and the worker delivers it to each of their devices.
import webpush from 'web-push';
import { databasePool } from './database.js';
import { env } from './env.js';
import { log } from './log.js';
import { PermanentJobError, type JobHandler } from './jobs/types.js';

/**
 * Push services browsers use. Subscription endpoints are supplied by
 * clients, so the worker only ever posts to these hosts.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  '.notify.windows.com',
  '.push.apple.com',
];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port) return false;
  return PUSH_HOSTS.some((h) => (h.startsWith('.') ? url.hostname.endsWith(h) : url.hostname === h));
}

interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export const handleNotificationPush: JobHandler = async (job) => {
  const config = env().webPush;
  if (!config) return { skipped: 'not_configured' };
  const id = String(job.payload.notification_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentJobError('Job has no notification_id');
  const db = databasePool();
  const notification = (await db.query<NotificationRow>('SELECT id, user_id, title, message, link, read FROM public.notifications WHERE id = $1', [id])).rows[0];
  if (!notification) return { skipped: 'deleted' };
  if (notification.read) return { skipped: 'read' };
  const subscriptions = (await db.query<SubscriptionRow>('SELECT id, endpoint, p256dh, auth FROM public.push_subscriptions WHERE user_id = $1', [notification.user_id])).rows;

  const payload = JSON.stringify({
    id: notification.id,
    title: notification.title,
    body: notification.message,
    url: notification.link?.startsWith('/') ? notification.link : '/notifications',
  });
  let delivered = 0;
  let removed = 0;
  let transient = 0;
  for (const s of subscriptions) {
    if (!isPushEndpoint(s.endpoint)) {
      await db.query('DELETE FROM public.push_subscriptions WHERE id = $1', [s.id]);
      removed++;
      continue;
    }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        vapidDetails: config,
        TTL: 24 * 60 * 60,
        urgency: 'high',
        // Retries replace an already shown notification instead of repeating it.
        topic: notification.id.replace(/-/g, '').slice(0, 32),
        timeout: 10_000,
      });
      delivered++;
      await db.query('UPDATE public.push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1', [s.id]);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410 || status === 403) {
        // Expired, unsubscribed, or created with different VAPID keys.
        await db.query('DELETE FROM public.push_subscriptions WHERE id = $1', [s.id]);
        removed++;
      } else {
        transient++;
        await db.query('UPDATE public.push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
        log.warn('push delivery failed', { notification_id: id, status: status ?? null, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (delivered === 0 && transient > 0) throw new Error(`Push delivery failed for ${transient} device(s)`);
  return { delivered, removed, failed: transient };
};
