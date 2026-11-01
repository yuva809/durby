import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Api,
  BUSY_RETRY_MAX_MS,
  read,
  WRITE_TIMEOUT_MS,
  type Schema,
  write,
} from './api-call';
import { ActionKey } from './idempotency';

const schema: Schema<{ ok: boolean }> = {
  safeParse: (value) => ({ success: true, data: value as { ok: boolean } }),
};

/** An apiFetch that never answers unless its request is aborted, like a stalled connection. */
function stalled() {
  const seen: RequestInit[] = [];
  const store: Api = {
    apiFetch: (_input, init) => {
      seen.push(init ?? {});
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation timed out.', 'TimeoutError')),
        );
      });
    },
  };
  return { store, seen };
}

describe('write timeout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives up on a stalled write with the generic error instead of waiting forever', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { store, seen } = stalled();

    const pending = write(store, new ActionKey(), '/api/v1/invitations', 'POST', { a: 1 }, schema);
    expect(timeout).toHaveBeenCalledWith(WRITE_TIMEOUT_MS);
    expect(seen[0]?.signal).toBe(controller.signal);

    controller.abort();
    expect(await pending).toEqual({ ok: false, code: 'unknown' });
  });

  it('keeps the Idempotency-Key of a timed-out write, so the retry replays instead of repeating', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { store, seen } = stalled();
    const action = new ActionKey(() => crypto.randomUUID());

    const first = write(store, action, '/api/v1/invitations', 'POST', { a: 1 }, schema);
    controller.abort();
    await first;

    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    void write(store, action, '/api/v1/invitations', 'POST', { a: 1 }, schema);
    const keyOf = (init?: RequestInit) => new Headers(init?.headers).get('Idempotency-Key');
    expect(keyOf(seen[0])).toBeTruthy();
    expect(keyOf(seen[1])).toBe(keyOf(seen[0]));
  });

  it('does not time out reads', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await read({ apiFetch: () => Promise.resolve(Response.json({ ok: true })) }, '/x', schema);
    expect(timeout).not.toHaveBeenCalled();
  });
});

describe('busy answers (503 with Retry-After, ADR 0021)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const busy = (retryAfter: string | null = '2') =>
    Response.json(
      { code: 'platform.busy', message: 'busy' },
      { status: 503, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } },
    );

  /** An apiFetch answering from `answers` in turn, recording each request. */
  function answering(...answers: (() => Response)[]) {
    const seen: { input: string; init: RequestInit | undefined }[] = [];
    const store: Api = {
      apiFetch: (input, init) => {
        seen.push({ input, init });
        return Promise.resolve(answers[seen.length - 1]!());
      },
    };
    return { store, seen };
  }

  it('retries a read once after Retry-After', async () => {
    vi.useFakeTimers();
    const { store, seen } = answering(
      () => busy('2'),
      () => Response.json({ ok: true }),
    );
    const pending = read(store, '/api/v1/reservations', schema);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, data: { ok: true } });
    expect(seen).toHaveLength(2);
  });

  it('retries a write once with the same Idempotency-Key', async () => {
    vi.useFakeTimers();
    const { store, seen } = answering(
      () => busy('1'),
      () => Response.json({ ok: true }, { status: 201 }),
    );
    const pending = write(store, new ActionKey(), '/api/v1/reservations', 'POST', { a: 1 }, schema);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ ok: true, data: { ok: true } });
    const keys = seen.map((s) => new Headers(s.init?.headers).get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('shows the error after a second busy answer, and caps the wait', async () => {
    vi.useFakeTimers();
    const { store, seen } = answering(
      () => busy('120'),
      () => busy('120'),
    );
    const pending = write(store, new ActionKey(), '/api/v1/reservations', 'POST', { a: 1 }, schema);
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MAX_MS);
    expect(await pending).toEqual({ ok: false, code: 'platform.busy' });
    expect(seen).toHaveLength(2);
  });

  it('does not retry a 503 without Retry-After, or any other error', async () => {
    const plain = answering(() => busy(null));
    expect(await read(plain.store, '/api/v1/x', schema)).toMatchObject({ ok: false });
    expect(plain.seen).toHaveLength(1);
    const failed = answering(() =>
      Response.json({ code: 'internal.error', message: 'x' }, { status: 500 }),
    );
    expect(await read(failed.store, '/api/v1/x', schema)).toMatchObject({ ok: false });
    expect(failed.seen).toHaveLength(1);
  });
});
