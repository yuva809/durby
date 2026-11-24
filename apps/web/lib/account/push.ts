import {
  type PushConfigResponse,
  pushConfigResponseSchema,
  pushStatusResponseSchema,
  type PushSubscriptionBody,
} from '@durby/shared';
import { type Api, read, type Result, write } from '../api-call';
import { ActionKey } from '../idempotency';

/**
 * Browser push on this device (docs/platform/notifications.md, ADR 0047): the service worker at /sw.js, the browser's
 * subscription with the server's VAPID key, and the api that keeps it per person and organization.
 */

export type PushState =
  /** The browser can't (no service worker / Push API, e.g. iOS Safari outside a home-screen app). */
  | 'unsupported'
  /** The server has no VAPID keys. */
  | 'unavailable'
  /** The person blocked notifications for this site in the browser. */
  | 'blocked'
  | 'off'
  | 'on';

export const loadPushConfig = (store: Api): Promise<Result<PushConfigResponse>> =>
  read(store, '/api/v1/notifications/push', pushConfigResponseSchema);

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * What the device is at now for this organization. A browser has one subscription; the api keeps it per
 * organization, so "on" needs the api to know it here.
 */
export async function pushState(store: Api, publicKey: string | null): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!publicKey) return 'unavailable';
  if (Notification.permission === 'denied') return 'blocked';
  const subscription = await currentSubscription();
  if (!subscription) return 'off';
  const status = await write(
    store,
    new ActionKey(),
    '/api/v1/notifications/push/status',
    'POST',
    { endpoint: subscription.endpoint },
    pushStatusResponseSchema,
  );
  return status.ok && status.data?.subscribed ? 'on' : 'off';
}

/** base64url VAPID key → bytes, as PushManager.subscribe wants it. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bodyOf(subscription: PushSubscription): PushSubscriptionBody {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
}

/** A browser that doesn't reach its push service may never answer. */
export const SUBSCRIBE_TIMEOUT_MS = 20_000;

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('push subscription timed out')), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Asks the browser's permission (must follow a tap), subscribes and tells the api. */
export async function turnPushOn(store: Api, publicKey: string): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await within(
      SUBSCRIBE_TIMEOUT_MS,
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      }),
    ));
  const saved = await write(
    store,
    new ActionKey(),
    '/api/v1/notifications/push/subscribe',
    'POST',
    bodyOf(subscription),
  );
  return saved.ok ? 'on' : 'off';
}

/**
 * Off for this organization. The browser keeps its subscription (other organizations or accounts on this device may
 * still use it); the api simply stops sending here.
 */
export async function turnPushOff(store: Api): Promise<PushState> {
  const subscription = await currentSubscription();
  if (!subscription) return 'off';
  await write(store, new ActionKey(), '/api/v1/notifications/push/unsubscribe', 'POST', {
    endpoint: subscription.endpoint,
  });
  return 'off';
}
