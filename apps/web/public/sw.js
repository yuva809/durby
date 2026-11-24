// Push service worker (docs/platform/notifications.md, ADR 0047). Only shows push messages and opens their page; no
// caching, no fetch handling. The message is { title, body?, url } with url a path on this site.
/* global self, URL */
'use strict';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let message = { title: '', url: '/' };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    // Not ours or not JSON: show nothing rather than something wrong.
    return;
  }
  if (!message.title) return;
  event.waitUntil(
    self.registration.showNotification(message.title, {
      ...(typeof message.body === 'string' ? { body: message.body } : {}),
      data: { url: message.url },
      // One per page: a newer update about the same thing replaces the older one.
      tag: message.url,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/';
  // Only paths on this site: never an absolute URL from the message.
  const target = new URL(
    path.startsWith('/') && !path.startsWith('//') ? path : '/',
    self.location.origin,
  );
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === target.origin);
      if (open) {
        return open
          .focus()
          .then((w) => (w && 'navigate' in w ? w.navigate(target.href) : undefined));
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
