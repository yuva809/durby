import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openStream,
  reconnectDelay,
  RECONNECT_MAX_MS,
  STABLE_AFTER_MS,
  type StreamHandlers,
  streamPath,
} from './stream';

const LOCATION = '0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f60';
const ORDER = '0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f61';
const READY = `event: ready\ndata: {"heartbeatMs":15000,"expiresAt":"2026-11-11T10:20:00.000Z"}\n\n`;

/** A stream response the test writes to. */
function body() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

function handlers() {
  const log: string[] = [];
  const h: StreamHandlers = {
    state: (s) => log.push(`state:${s}`),
    ready: () => log.push('ready'),
    changed: (c) => log.push(`changed:${c.topic}:${c.ids.join(',')}`),
    resync: () => log.push('resync'),
  };
  return { log, h };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('reconnectDelay', () => {
  it('doubles from 1 s to at most 30 s, with ±20 % jitter', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => reconnectDelay(a, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(reconnectDelay(0, () => 0)).toBe(800);
    expect(reconnectDelay(10, () => 1)).toBe(RECONNECT_MAX_MS * 1.2);
  });
});

describe('openStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the module route for the location with the stream headers', async () => {
    const apiFetch = vi.fn().mockResolvedValue(body().response);
    const { h } = handlers();
    const connection = openStream({ apiFetch }, streamPath('reservations', LOCATION), h);
    await flush();
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/v1/reservations/stream?locationId=${LOCATION}`,
      expect.objectContaining({ headers: { Accept: 'text/event-stream' }, cache: 'no-store' }),
    );
    connection.close();
  });

  it('is live after ready and passes hints and resyncs on', async () => {
    const b = body();
    const { log, h } = handlers();
    const connection = openStream({ apiFetch: vi.fn().mockResolvedValue(b.response) }, '/s', h);
    await flush();
    b.push(READY);
    b.push(': ping\n\nevent: changed\ndata: {"topic":"pos.floor","ids":["');
    b.push(`${ORDER}"]}\n\nevent: resync\ndata: {}\n\n`);
    // Malformed or unknown messages are ignored.
    b.push(
      'event: changed\ndata: {"topic":"pos.floor","ids":["x"]}\n\nevent: changed\ndata: nope\n\n',
    );
    await flush();
    expect(log).toEqual([
      'state:connecting',
      'state:live',
      'ready',
      `changed:pos.floor:${ORDER}`,
      'resync',
    ]);
    connection.close();
  });

  it('reconnects with growing delays after drops, and resets them after a stable stream', async () => {
    const bodies = Array.from({ length: 5 }, body);
    let i = 0;
    const apiFetch = vi.fn(() => Promise.resolve(bodies[i++]!.response));
    const { log, h } = handlers();
    const connection = openStream({ apiFetch }, '/s', h, () => 0.5);
    await flush();
    bodies[0]!.end(); // dropped before ready
    await flush();
    expect(log.at(-1)).toBe('state:down');
    await vi.advanceTimersByTimeAsync(999);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    bodies[1]!.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    // This one lives a minute (pings keep the watchdog quiet), then ends: back to 1 s.
    bodies[2]!.push(READY);
    for (let t = 0; t < STABLE_AFTER_MS; t += 15_000) {
      bodies[2]!.push(': ping\n\n');
      await vi.advanceTimersByTimeAsync(15_000);
    }
    bodies[2]!.end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(apiFetch).toHaveBeenCalledTimes(4);
    connection.close();
  });

  it('treats a stream without any line for two pings and 10 s as dead', async () => {
    const bodies = [body(), body()];
    let i = 0;
    const apiFetch = vi.fn(() => Promise.resolve(bodies[i++]!.response));
    const { log, h } = handlers();
    const connection = openStream({ apiFetch }, '/s', h, () => 0.5);
    await flush();
    bodies[0]!.push(READY);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(log.at(-1)).toBe('ready');
    await vi.advanceTimersByTimeAsync(1);
    expect(log.at(-1)).toBe('state:down');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    connection.close();
  });

  it('retries server errors and network failures, but stops on 403, 404 and 400', async () => {
    const apiFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }));
    const { log, h } = handlers();
    openStream({ apiFetch }, '/s', h, () => 0.5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(log.at(-1)).toBe('state:stopped');
    for (const status of [400, 403]) {
      const { log: l, h: hh } = handlers();
      openStream({ apiFetch: vi.fn().mockResolvedValue(new Response('{}', { status })) }, '/s', hh);
      await flush();
      expect(l).toEqual(['state:connecting', 'state:stopped']);
    }
  });

  it('stops for good on close: no retry, no more callbacks', async () => {
    const b = body();
    const apiFetch = vi.fn().mockResolvedValue(b.response);
    const { log, h } = handlers();
    const connection = openStream({ apiFetch }, '/s', h);
    await flush();
    connection.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['state:connecting']);
  });
});
