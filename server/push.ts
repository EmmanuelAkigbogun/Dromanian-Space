// Web Push. Browsers subscribe through /api/push. The notifications trigger
// queues a notification.push job (tasks, approvals, announcements, mentions)
// and new direct messages queue a message.push job, for people with a
// subscription; the worker delivers each to all of their devices.
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
  if (!env().webPush) return { skipped: 'not_configured' };
  const id = String(job.payload.notification_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentJobError('Job has no notification_id');
  const db = databasePool();
  const notification = (await db.query<NotificationRow>('SELECT id, user_id, title, message, link, read FROM public.notifications WHERE id = $1', [id])).rows[0];
  if (!notification) return { skipped: 'deleted' };
  if (notification.read) return { skipped: 'read' };
  const payload = JSON.stringify({
    id: notification.id,
    title: notification.title,
    body: notification.message,
    url: notification.link?.startsWith('/') ? notification.link : '/notifications',
  });
  return deliver(notification.user_id, payload, notification.id);
};

interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: Date;
  deleted_at: Date | null;
  author: string | null;
  conversation_id: string | null;
  last_read_at: Date | null;
  muted: boolean | null;
}

/** A direct message, to one participant, unless they already read it. */
export const handleMessagePush: JobHandler = async (job) => {
  if (!env().webPush) return { skipped: 'not_configured' };
  const id = String(job.payload.message_id ?? '');
  const userId = String(job.payload.user_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(userId)) throw new PermanentJobError('Job has no message_id or user_id');
  const db = databasePool();
  const message = (await db.query<MessageRow>(
    `SELECT m.id, m.channel_id, m.user_id, m.content, m.created_at, m.deleted_at,
            coalesce(nullif(p.display_name, ''), p.username) AS author,
            dc.id AS conversation_id, cm.last_read_at, cm.muted
       FROM public.messages m
       LEFT JOIN public.profiles p ON p.id = m.user_id
       LEFT JOIN public.direct_conversations dc ON dc.channel_id = m.channel_id
       LEFT JOIN public.channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $2
      WHERE m.id = $1`, [id, userId])).rows[0];
  if (!message || message.deleted_at) return { skipped: 'deleted' };
  if (message.muted) return { skipped: 'muted' };
  if (message.last_read_at && message.last_read_at >= message.created_at) return { skipped: 'read' };
  const text = message.content.replace(/s+/g, ' ').trim();
  const payload = JSON.stringify({
    id: message.id,
    title: message.author ?? 'New message',
    body: text ? (text.length > 140 ? `${text.slice(0, 139)}…` : text) : 'Sent an attachment',
    url: message.conversation_id ? `/dm/${message.conversation_id}` : '/dm',
    tag: `dm:${message.channel_id}`,
  });
  const result = await deliver(userId, payload, message.id);
  if (result.delivered > 0) {
    // Reaching one of their devices counts as delivered for the sender's ticks.
    const row = (await db.query<{ id: string }>(
      `UPDATE public.channel_members SET last_delivered_at = greatest(coalesce(last_delivered_at, '-infinity'), $3)
        WHERE channel_id = $1 AND user_id = $2 AND coalesce(last_delivered_at, '-infinity') < $3 RETURNING id`,
      [message.channel_id, userId, message.created_at])).rows[0];
    if (row) await db.query('SELECT public.announce_channel_member($1)', [row.id]);
  }
  return result;
};

/** Sends one payload to every device a person subscribed. */
async function deliver(userId: string, payload: string, id: string) {
  const config = env().webPush!;
  const db = databasePool();
  const subscriptions = (await db.query<SubscriptionRow>('SELECT id, endpoint, p256dh, auth FROM public.push_subscriptions WHERE user_id = $1', [userId])).rows;
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
        topic: id.replace(/-/g, '').slice(0, 32),
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
        log.warn('push delivery failed', { id, status: status ?? null, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (delivered === 0 && transient > 0) throw new Error(`Push delivery failed for ${transient} device(s)`);
  return { delivered, removed, failed: transient };
}
