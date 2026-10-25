// Web Push for this browser: task assignments and approval requests arrive
// as system notifications even when the app is closed. The desktop app shows
// its own notifications and does not use this.
import { api, platform } from '@/features/platform/client';

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const WORKER_URL = '/sw.js';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !window.darkspaceDesktop &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function serverConfig(): Promise<{ enabled: boolean; public_key: string | null }> {
  return (await api('push')).json();
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(WORKER_URL);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const config = await serverConfig().catch(() => null);
  if (!config?.enabled) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const subscription = await currentSubscription().catch(() => null);
  if (subscription && Notification.permission === 'granted') {
    // Re-register so the subscription follows whoever is signed in here.
    await api('push', subscription.toJSON()).catch(() => undefined);
    return 'on';
  }
  return 'off';
}

/** Asks for permission (call from a click) and registers this browser. */
export async function enablePush(): Promise<PushState> {
  const config = await serverConfig();
  if (!config.enabled || !config.public_key) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.register(WORKER_URL, { scope: '/' });
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.public_key) });
  }
  await api('push', subscription.toJSON());
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const subscription = await currentSubscription();
  if (subscription) {
    await deleteSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return 'off';
}

/** On sign-out: stop pushing the previous person's notifications to this browser. */
export async function forgetPushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await deleteSubscription(subscription.endpoint).catch(() => undefined);
}

async function deleteSubscription(endpoint: string): Promise<void> {
  const { data: { session } } = await platform.auth.getSession();
  if (!session) return;
  await fetch('/api/push', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}
