import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from './auth/session';
import { ActionKey, sendAction, withIdempotencyKey } from './idempotency';

const keys = () => {
  let n = 0;
  return () => `key-${++n}`;
};

describe('ActionKey', () => {
  it('reuses the key for the same input until the action is done', () => {
    const action = new ActionKey(keys());
    expect(action.for({ value: 'UTC' })).toBe('key-1');
    expect(action.for({ value: 'UTC' })).toBe('key-1');
    action.done();
    expect(action.for({ value: 'UTC' })).toBe('key-2');
  });

  it('takes a new key when the input changes', () => {
    const action = new ActionKey(keys());
    expect(action.for({ value: 'UTC' })).toBe('key-1');
    expect(action.for({ value: 'CET' })).toBe('key-2');
  });

  it('defaults to random UUIDs', () => {
    expect(new ActionKey().for(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('withIdempotencyKey', () => {
  it('sets the header and keeps the others', () => {
    const init = withIdempotencyKey({ method: 'PUT', headers: { 'Content-Type': 'x' } }, 'k');
    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toBe('k');
    expect(headers.get('Content-Type')).toBe('x');
    expect(init.method).toBe('PUT');
  });
});

describe('sendAction', () => {
  const put = { method: 'PUT', body: '{"value":"UTC"}' };
  const store = (...statuses: number[]) => {
    const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(null, { status: statuses.shift() ?? 200 })),
    );
    return {
      apiFetch,
      keyOf: (i: number) =>
        new Headers(apiFetch.mock.calls[i]?.[1]?.headers).get('Idempotency-Key'),
    };
  };

  it('retries a 5xx or a 409 with the same key, then starts a new action after success', async () => {
    const s = store(503, 409, 200, 200);
    const action = new ActionKey(keys());
    await sendAction(s, action, '/api/v1/settings/timezone', put);
    await sendAction(s, action, '/api/v1/settings/timezone', put);
    await sendAction(s, action, '/api/v1/settings/timezone', put);
    await sendAction(s, action, '/api/v1/settings/timezone', put);
    expect([0, 1, 2, 3].map(s.keyOf)).toEqual(['key-1', 'key-1', 'key-1', 'key-2']);
  });

  it('ends the action on a 4xx answer', async () => {
    const s = store(422, 200);
    const action = new ActionKey(keys());
    await sendAction(s, action, '/x', put);
    await sendAction(s, action, '/x', put);
    expect([0, 1].map(s.keyOf)).toEqual(['key-1', 'key-2']);
  });

  it('keeps the key when the network fails', async () => {
    const apiFetch = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const action = new ActionKey(keys());
    await expect(sendAction({ apiFetch }, action, '/x', put)).rejects.toThrow('offline');
    await sendAction({ apiFetch }, action, '/x', put);
    const keyOf = (i: number) =>
      new Headers(apiFetch.mock.calls[i]?.[1]?.headers).get('Idempotency-Key');
    expect([keyOf(0), keyOf(1)]).toEqual(['key-1', 'key-1']);
  });

  it('sends the same key again when apiFetch resends after a token refresh', async () => {
    const session = (accessToken: string) =>
      Response.json({
        accessToken,
        expiresIn: 600,
        user: { id: uuidv7(), email: 'a@b.test', locale: 'en' },
        organizations: [],
        activeOrganizationId: null,
        activeRole: null,
        activePermissions: [],
        activeFeatures: [],
      });
    const responses = [
      session('access-1'),
      Response.json({ code: 'auth.unauthenticated', message: 'x' }, { status: 401 }),
      session('access-2'),
      new Response(null, { status: 200 }),
    ];
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
    );
    const sessionStore = createSessionStore({
      fetch: fetchImpl,
      now: () => 0,
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    await sessionStore.login('a@b.test', 'pw');
    await sendAction(sessionStore, new ActionKey(keys()), '/api/v1/settings/timezone', put);
    const keyOf = (i: number) =>
      new Headers(fetchImpl.mock.calls[i]?.[1]?.headers).get('Idempotency-Key');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/v1/auth/refresh');
    expect([keyOf(1), keyOf(3)]).toEqual(['key-1', 'key-1']);
  });
});
