// Push service worker (docs/platform/notifications.md, ADR 0047). Only shows push messages and opens their page; no
// caching, no fetch handling. The message is { title, url } with url a path on this site.
/* global self, URL */
'use strict';

// Static files only (ADR 0072): hashed Next.js assets. Pages, API answers and sign-in state are never stored.
const STATIC_CACHE = 'durby-static-v1';

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

// Drops the static caches of older versions when this one activates (ADR 0072).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('durby-static-') && k !== STATIC_CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
});

// Serves hashed build files from the cache, and stores them on first use. Nothing else is cached.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/_next/static/')) return;
  event.respondWith(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          }),
      ),
    ),
  );
});
