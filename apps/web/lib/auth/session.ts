import { apiErrorBodySchema, type MeResponse, sessionResponseSchema } from '@durby/shared';
import type { ApiErrorCode } from './errors';

/**
 * Client-side session (docs/platform/auth.md → Web). The access token lives in this module's
 * memory only: never in browser storage or a script-readable cookie. A reload loses it, and
 * refresh() gets a new one with the httpOnly refresh cookie the api set.
 */

export const AUTH_API = '/api/v1/auth';
/** Refresh this long before the access token expires. */
export const REFRESH_LEEWAY_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;
/** Web Locks name: one refresh at a time across tabs, or rotation would look like token reuse. */
export const REFRESH_LOCK = 'durby-auth-refresh';

/** Refresh failures that mean the session is over (sign in again). */
const SESSION_ENDED: ReadonlySet<string> = new Set([
  'auth.refresh_invalid',
  'auth.refresh_reused',
  'auth.unauthenticated',
]);

export interface Session extends MeResponse {
  accessToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export type AuthResult = { ok: true } | { ok: false; code: ApiErrorCode | 'unknown' };

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface SessionStoreDeps {
  fetch: typeof fetch;
  now?: () => number;
  /** navigator.locks when available. */
  locks?: LockManagerLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Function properties (not methods): safe to pass around unbound, e.g. to useSyncExternalStore. */
export interface SessionStore {
  get: () => Session | null;
  subscribe: (listener: (session: Session | null) => void) => () => void;
  login: (email: string, password: string) => Promise<AuthResult>;
  /** Restores or renews the session from the refresh cookie. Concurrent calls share one request. */
  refresh: () => Promise<AuthResult>;
  logout: () => Promise<void>;
  switchOrganization: (organizationId: string) => Promise<AuthResult>;
  /** Your own password (and a temporary one, ADR 0023 §3); the api starts a fresh session. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthResult>;
  /** fetch with the access token; on 401 refreshes once and retries. */
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>;
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const listeners = new Set<(session: Session | null) => void>();
  let session: Session | null = null;
  let timer: unknown;
  let inflight: Promise<AuthResult> | null = null;

  const post = (path: string, body?: unknown, headers: HeadersInit = {}) =>
    deps.fetch(`${AUTH_API}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  function set(next: Session | null): void {
    session = next;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (next) {
      const delay = Math.max(next.expiresAt - now() - REFRESH_LEEWAY_MS, MIN_REFRESH_DELAY_MS);
      timer = setTimer(() => void store.refresh(), delay);
    }
    for (const listener of listeners) listener(next);
  }

  async function fromResponse(res: Response): Promise<AuthResult> {
    if (!res.ok) return { ok: false, code: await errorCode(res) };
    const parsed = sessionResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, code: 'unknown' };
    const { accessToken, expiresIn, ...me } = parsed.data;
    set({ ...me, accessToken, expiresAt: now() + expiresIn * 1000 });
    return { ok: true };
  }

  async function doRefresh(): Promise<AuthResult> {
    try {
      const result = await fromResponse(await post('/refresh'));
      // Only a dead session ends it; rate limits, outages and network errors keep the current one.
      if (!result.ok && SESSION_ENDED.has(result.code)) set(null);
      return result;
    } catch {
      return { ok: false, code: 'unknown' };
    }
  }

  const store: SessionStore = {
    get: () => session,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async login(email, password) {
      try {
        return await fromResponse(await post('/login', { email, password }));
      } catch {
        return { ok: false, code: 'unknown' };
      }
    },

    refresh() {
      inflight ??= (deps.locks ? deps.locks.request(REFRESH_LOCK, doRefresh) : doRefresh()).finally(
        () => {
          inflight = null;
        },
      );
      return inflight;
    },

    async logout() {
      try {
        await post('/logout');
      } finally {
        set(null);
      }
    },

    async switchOrganization(organizationId) {
      if (!session) return { ok: false, code: 'auth.unauthenticated' };
      try {
        return await fromResponse(
          await post(
            '/switch-organization',
            { organizationId },
            { Authorization: `Bearer ${session.accessToken}` },
          ),
        );
      } catch {
        return { ok: false, code: 'unknown' };
      }
    },

    async changePassword(currentPassword, newPassword) {
      if (!session) return { ok: false, code: 'auth.unauthenticated' };
      try {
        return await fromResponse(
          await post(
            '/password/change',
            { currentPassword, newPassword },
            { Authorization: `Bearer ${session.accessToken}` },
          ),
        );
      } catch {
        return { ok: false, code: 'unknown' };
      }
    },

    async apiFetch(input, init = {}) {
      const send = () => {
        const headers = new Headers(init.headers);
        if (session) headers.set('Authorization', `Bearer ${session.accessToken}`);
        return deps.fetch(input, { ...init, headers, credentials: 'same-origin' });
      };
      const res = await send();
      if (res.status !== 401 || !session) return res;
      const refreshed = await store.refresh();
      return refreshed.ok ? send() : res;
    },
  };
  return store;
}

/**
 * The `code` of an api error body (parsed with the shared schema), or 'unknown'. A code the web
 * app doesn't know still maps to the generic label (errorLabel).
 */
export async function errorCode(res: Response): Promise<ApiErrorCode | 'unknown'> {
  try {
    const parsed = apiErrorBodySchema.safeParse(await res.json());
    return parsed.success ? (parsed.data.code as ApiErrorCode) : 'unknown';
  } catch {
    return 'unknown';
  }
}
