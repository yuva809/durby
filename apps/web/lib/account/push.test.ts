// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBSCRIBE_TIMEOUT_MS, turnPushOn } from './push';

const subscribe = vi.fn();
const store = { apiFetch: vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))) };
const subscription = {
  endpoint: 'https://push.example/1',
  toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
};

beforeEach(() => {
  vi.useFakeTimers();
  subscribe.mockReset();
  const registration = {
    pushManager: { getSubscription: () => Promise.resolve(null), subscribe },
  };
  vi.stubGlobal('Notification', { requestPermission: () => Promise.resolve('granted') });
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: () => Promise.resolve(registration),
      ready: Promise.resolve(registration),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('turning push on', () => {
  it('is on once the browser subscribed and the api knows', async () => {
    subscribe.mockResolvedValue(subscription);
    expect(await turnPushOn(store, 'AQID')).toBe('on');
    expect(store.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a browser that never answers', async () => {
    subscribe.mockReturnValue(new Promise(() => undefined));
    const result = expect(turnPushOn(store, 'AQID')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_TIMEOUT_MS);
    await result;
  });
});
