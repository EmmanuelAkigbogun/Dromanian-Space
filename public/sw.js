// Service worker for Web Push only: it shows notifications sent by the server
// (messages, mentions, tasks) even while the app is closed, and opens the app
// at the notification's link. It caches nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const safeNotificationTarget = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return '/notifications';
  }
  try {
    const resolved = new URL(value, self.location.origin);
    if (resolved.origin !== self.location.origin) return '/notifications';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/notifications';
  }
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Darkspace', body: event.data ? event.data.text() : '' };
  }
  const url = safeNotificationTarget(data.url);
  event.waitUntil(
    self.registration.showNotification(data.title || 'Darkspace', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // A conversation's messages replace each other instead of stacking up.
      tag: data.tag || data.id || undefined,
      renotify: !!data.tag,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safeNotificationTarget(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ('navigate' in open) return open.navigate(target);
        return undefined;
      }
      return self.clients.openWindow(target);
    })(),
  );
});
