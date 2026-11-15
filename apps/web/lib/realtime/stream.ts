import {
  REALTIME_HEARTBEAT_MS,
  type RealtimeChanged,
  realtimeChangedSchema,
  realtimeDeadAfterMs,
  type RealtimeReady,
  realtimeReadySchema,
  type RealtimeStream,
} from '@durby/shared';
import type { Api } from '../api-call';
import { createSseParser } from './parser';

/**
 * A module's live-update stream (docs/platform/realtime.md, ADR 0044), read with `fetch` so the
 * bearer token goes along (EventSource can't send it); `apiFetch` refreshes it on a 401.
 *
 * - `live`: the stream is open (after `ready`).
 * - `down`: not open now; reconnecting with backoff (1 s doubling to 30 s, ±20 %), the page polls.
 * - `stopped`: the api refused the stream for good (403/404/400, or no stream route: an older
 *   release); the page polls until it opens the stream again (another location, a new visit).
 */
export type StreamState = 'connecting' | 'live' | 'down' | 'stopped';

export interface StreamHandlers {
  state(state: StreamState): void;
  ready(ready: RealtimeReady): void;
  changed(changed: RealtimeChanged): void;
  resync(): void;
}

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** A stream that lived this long resets the backoff. */
export const STABLE_AFTER_MS = 60_000;

/** The delay before reconnect attempt `attempt` (0-based), with ±20 % jitter from `random()`. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return Math.round(base * (0.8 + random() * 0.4));
}

export function streamPath(stream: RealtimeStream, locationId: string): string {
  return `/api/v1/${stream}/stream?${new URLSearchParams({ locationId })}`;
}

/** Answers that won't change by retrying: stop and keep polling. */
const FINAL_STATUSES = new Set([400, 403, 404, 405]);

export function openStream(
  store: Api,
  path: string,
  handlers: StreamHandlers,
  random: () => number = Math.random,
): { close(): void } {
  let closed = false;
  let attempt = 0;
  let controller: AbortController | undefined;
  let reader: ReadableStreamDefaultReader<string> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const retry = () => {
    if (closed) return;
    handlers.state('down');
    retryTimer = setTimeout(() => void connect(), reconnectDelay(attempt, random));
    attempt++;
  };

  /** Ends the current attempt: the request, and the body if it already arrived. */
  const stop = () => {
    controller?.abort();
    void reader?.cancel().catch(() => undefined);
  };

  const connect = async () => {
    if (closed) return;
    handlers.state('connecting');
    controller = new AbortController();
    const signal = controller.signal;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let deadAfter = realtimeDeadAfterMs(REALTIME_HEARTBEAT_MS);
    const alive = () => {
      clearTimeout(watchdog);
      // No line for too long: a sleeping tablet or a half-open connection. Abort and reconnect.
      watchdog = setTimeout(stop, deadAfter);
    };
    let openedAt: number | null = null;
    try {
      alive();
      const res = await store.apiFetch(path, {
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        signal,
      });
      if (FINAL_STATUSES.has(res.status)) {
        clearTimeout(watchdog);
        if (!closed) handlers.state('stopped');
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);
      const parser = createSseParser({
        event: (name, data) => {
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            return;
          }
          if (name === 'ready') {
            const ready = realtimeReadySchema.safeParse(json);
            if (!ready.success) return;
            deadAfter = realtimeDeadAfterMs(ready.data.heartbeatMs);
            openedAt = Date.now();
            handlers.state('live');
            handlers.ready(ready.data);
          } else if (name === 'changed') {
            const changed = realtimeChangedSchema.safeParse(json);
            if (changed.success) handlers.changed(changed.data);
          } else if (name === 'resync') {
            handlers.resync();
          }
        },
      });
      reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        alive();
        parser.feed(value);
      }
    } catch {
      // Network error, abort (watchdog or close()), bad answer: all mean "not connected now".
    } finally {
      clearTimeout(watchdog);
    }
    if (closed) return;
    if (openedAt !== null && Date.now() - openedAt >= STABLE_AFTER_MS) attempt = 0;
    retry();
  };

  void connect();
  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      stop();
    },
  };
}
