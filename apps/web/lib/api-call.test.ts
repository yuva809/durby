import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Api, read, WRITE_TIMEOUT_MS, type Schema, write } from './api-call';
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
