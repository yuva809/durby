'use client';

import { useEffect } from 'react';

/**
 * Registers the app's service worker (`/sw.js`), which caches the static files only (ADR 0072). Push messages are
 * handled by the same worker (ADR 0047); registering it twice is harmless.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
