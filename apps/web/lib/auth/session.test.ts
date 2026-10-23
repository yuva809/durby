import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore, REFRESH_LOCK, type SessionStoreDeps } from './session';

const user = { id: uuidv7(), email: 'a@b.test', locale: 'en' };
const org = { id: uuidv7(), name: 'Org' };
const sessionBody = (accessToken = 'access-1', activeOrganizationId: string | null = org.id) => ({
  accessToken,
  expiresIn: 600,
  user,
  organizations: [org],
  activeOrganizationId,
  activeRole: null,
  activePermissions: [],
  activeFeatures: [],
});
const error = (status: number, code: string) => Response.json({ code, message: 'x' }, { status });

function setup(responses: (Response | Error)[] = [], extra: Partial<SessionStoreDeps> = {}) {
  const queue = [...responses];
  const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    () => {
      const next = queue.shift() ?? Response.json(sessionBody());
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  );
  const timers: { fn: () => void; ms: number }[] = [];
  const store = createSessionStore({
    fetch: fetchImpl,
    now: () => 1_000_000,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    ...extra,
  });
  return { store, fetchImpl, timers };
}

const call = (fetchImpl: ReturnType<typeof setup>['fetchImpl'], i: number) => {
  const [url, init] = fetchImpl.mock.calls[i] ?? [];
  return { url, init: init ?? {}, headers: new Headers(init?.headers) };
};

describe('session store', () => {
  it('login stores the session in memory and schedules a refresh before expiry', async () => {
    const { store, fetchImpl, timers } = setup([Response.json(sessionBody())]);
    expect(await store.login('a@b.test', 'pw')).toEqual({ ok: true });
    expect(store.get()).toEqual({
      user,
      organizations: [org],
      activeOrganizationId: org.id,
      activeRole: null,
      activePermissions: [],
      activeFeatures: [],
      accessToken: 'access-1',
      expiresAt: 1_000_000 + 600_000,
    });
    expect(call(fetchImpl, 0)).toMatchObject({
      url: '/api/v1/auth/login',
      init: {
        method: 'POST',
        credentials: 'same-origin',
        body: '{"email":"a@b.test","password":"pw"}',
      },
    });
    expect(timers.at(-1)?.ms).toBe(540_000);
  });

  it('returns the error code of a failed login and keeps no session', async () => {
    const { store } = setup([error(401, 'auth.invalid_credentials')]);
    expect(await store.login('a@b.test', 'nope')).toEqual({
      ok: false,
      code: 'auth.invalid_credentials',
    });
    expect(store.get()).toBeNull();
  });

  it('runs one refresh for concurrent callers', async () => {
    const { store, fetchImpl } = setup();
    const results = await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(call(fetchImpl, 0).url).toBe('/api/v1/auth/refresh');
  });

  it('refreshes under a Web Lock so tabs never rotate the cookie at the same time', async () => {
    const names: string[] = [];
    const request = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      names.push(name);
      return fn();
    };
    const { store } = setup([], { locks: { request } });
    await store.refresh();
    expect(names).toEqual([REFRESH_LOCK]);
  });

  it('the scheduled refresh renews the token', async () => {
    const { store, timers } = setup([
      Response.json(sessionBody('access-1')),
      Response.json(sessionBody('access-2')),
    ]);
    await store.login('a@b.test', 'pw');
    timers.at(-1)?.fn();
    await vi.waitFor(() => expect(store.get()?.accessToken).toBe('access-2'));
  });

  it('ends the session when the refresh token is dead, but not on transient errors', async () => {
    const { store } = setup([
      Response.json(sessionBody()),
      error(503, 'auth.unavailable'),
      error(429, 'auth.rate_limited'),
      new Error('network down'),
      error(401, 'auth.refresh_reused'),
    ]);
    await store.login('a@b.test', 'pw');
    expect((await store.refresh()).ok).toBe(false);
    expect((await store.refresh()).ok).toBe(false);
    expect((await store.refresh()).ok).toBe(false);
    expect(store.get()).not.toBeNull();
    expect(await store.refresh()).toEqual({ ok: false, code: 'auth.refresh_reused' });
    expect(store.get()).toBeNull();
  });

  it('logout calls the api and clears the session even if the call fails', async () => {
    const { store, fetchImpl } = setup([Response.json(sessionBody()), new Error('offline')]);
    const seen: unknown[] = [];
    store.subscribe((s) => seen.push(s));
    await store.login('a@b.test', 'pw');
    await expect(store.logout()).rejects.toThrow('offline');
    expect(store.get()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(call(fetchImpl, 1).url).toBe('/api/v1/auth/logout');
  });

  it('switchOrganization sends the access token and adopts the new session', async () => {
    const other = uuidv7();
    const { store, fetchImpl } = setup([
      Response.json(sessionBody('access-1')),
      Response.json(sessionBody('access-2', other)),
    ]);
    await store.login('a@b.test', 'pw');
    expect(await store.switchOrganization(other)).toEqual({ ok: true });
    const { url, init, headers } = call(fetchImpl, 1);
    expect(url).toBe('/api/v1/auth/switch-organization');
    expect(headers.get('Authorization')).toBe('Bearer access-1');
    expect(init.body).toBe(JSON.stringify({ organizationId: other }));
    expect(store.get()).toMatchObject({ accessToken: 'access-2', activeOrganizationId: other });
  });

  it('apiFetch adds the bearer token and retries once after refreshing on 401', async () => {
    const { store, fetchImpl } = setup([
      Response.json(sessionBody('access-1')),
      error(401, 'auth.unauthenticated'),
      Response.json(sessionBody('access-2')),
      Response.json({ hello: 'world' }),
    ]);
    await store.login('a@b.test', 'pw');
    const res = await store.apiFetch('/api/v1/something');
    expect(await res.json()).toEqual({ hello: 'world' });
    expect(call(fetchImpl, 1).headers.get('Authorization')).toBe('Bearer access-1');
    expect(call(fetchImpl, 2).url).toBe('/api/v1/auth/refresh');
    expect(call(fetchImpl, 3).headers.get('Authorization')).toBe('Bearer access-2');
  });

  describe('never persists the token', () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, prop) => {
            touched.push(`${name}.${String(prop)}`);
            return () => undefined;
          },
        },
      );

    beforeEach(() => {
      touched.length = 0;
      vi.stubGlobal('localStorage', trap('localStorage'));
      vi.stubGlobal('sessionStorage', trap('sessionStorage'));
      vi.stubGlobal('document', trap('document'));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('no flow touches localStorage, sessionStorage or document (cookies)', async () => {
      const { store } = setup();
      await store.login('a@b.test', 'pw');
      await store.refresh();
      await store.switchOrganization(org.id);
      await store.apiFetch('/api/v1/x');
      await store.logout();
      expect(touched).toEqual([]);
    });

    it('no web source file mentions browser storage or document.cookie', () => {
      const root = join(__dirname, '..', '..');
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          if (['node_modules', '.next'].includes(name)) continue;
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) files.push(path);
        }
      };
      walk(join(root, 'app'));
      walk(join(root, 'lib'));
      const offenders = files.filter((f) =>
        /localStorage|sessionStorage|indexedDB|document\.cookie/.test(readFileSync(f, 'utf8')),
      );
      expect(offenders).toEqual([]);
    });
  });
});
