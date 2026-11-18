// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamHandlers } from './stream';
import { HINT_DEBOUNCE_MS, LIVE_SAFETY_RELOAD_MS, useLiveRefresh } from './use-live-refresh';

const opened: { path: string; handlers: StreamHandlers; close: ReturnType<typeof vi.fn> }[] = [];
vi.mock('./stream', async (original) => ({
  ...(await original<typeof import('./stream')>()),
  openStream: (_store: unknown, path: string, handlers: StreamHandlers) => {
    const close = vi.fn();
    opened.push({ path, handlers, close });
    return { close };
  },
}));

const LOCATION = '0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f60';
const POLL_MS = 30_000;
const store = { apiFetch: vi.fn() };

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function setup(enabled = true) {
  const reload = vi.fn();
  const hook = renderHook(() =>
    useLiveRefresh({
      store,
      stream: 'reservations',
      locationId: LOCATION,
      enabled,
      reload,
      pollMs: POLL_MS,
    }),
  );
  return { reload, hook, last: () => opened.at(-1)! };
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useLiveRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    opened.length = 0;
    setVisibility('visible');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('opens the module stream for the location, and polls until it is live', async () => {
    const { reload, hook, last } = setup();
    expect(last().path).toBe(`/api/v1/reservations/stream?locationId=${LOCATION}`);
    expect(hook.result.current.live).toBe(false);
    await advance(POLL_MS);
    expect(reload).toHaveBeenCalledTimes(1);

    act(() => last().handlers.state('live'));
    expect(hook.result.current.live).toBe(true);
    await advance(POLL_MS * 2);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once per burst of hints, on ready and on resync', async () => {
    const { reload, last } = setup();
    act(() => last().handlers.state('live'));
    act(() => {
      last().handlers.ready({ heartbeatMs: 15_000, expiresAt: '2026-11-11T10:20:00.000Z' });
      for (let i = 0; i < 3; i++) last().handlers.changed({ topic: 'reservations', ids: [] });
    });
    await advance(HINT_DEBOUNCE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => last().handlers.resync());
    await advance(HINT_DEBOUNCE_MS);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('still reloads every 5 minutes while live, and polls again once the stream is down', async () => {
    const { reload, last } = setup();
    act(() => last().handlers.state('live'));
    await advance(LIVE_SAFETY_RELOAD_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => last().handlers.state('down'));
    await advance(POLL_MS);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('only polls without the feature or permission', async () => {
    const { reload } = setup(false);
    expect(opened).toEqual([]);
    await advance(POLL_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('closes the stream while hidden and catches up when visible again', async () => {
    const { reload, last } = setup();
    const first = last();
    setVisibility('hidden');
    expect(first.close).toHaveBeenCalled();
    await advance(POLL_MS * 3);
    expect(reload).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(2);
  });

  it('closes the stream on unmount', () => {
    const { hook, last } = setup();
    hook.unmount();
    expect(last().close).toHaveBeenCalled();
  });
});
