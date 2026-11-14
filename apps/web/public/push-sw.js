/* global self, clients */
// Web Push handlers, imported into the generated service worker (workbox
// `importScripts` in vite.config.ts). Every push shows a notification: iOS
// revokes the subscription of a page that receives pushes silently.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const scope = self.registration.scope;
  const sentAt = typeof data.sentAt === 'number' ? data.sentAt : 0;
  const url = new URL(`server/?from=push&sentAt=${sentAt}`, scope).href;
  const receivedAt = Date.now();
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || 'Family Chat', {
        body: data.body || 'Новое сообщение',
        icon: new URL('icon-192.png', scope).href,
        badge: new URL('icon-192.png', scope).href,
        tag: `fc-${sentAt || receivedAt}`,
        data: { url, sentAt },
      });
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) w.postMessage({ type: 'fc-push', sentAt, receivedAt });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (w.url.startsWith(self.registration.scope) && 'focus' in w) {
          await w.focus();
          w.postMessage({ type: 'fc-notification-click', sentAt: data.sentAt });
          return;
        }
      }
      await clients.openWindow(url);
    })(),
  );
});
