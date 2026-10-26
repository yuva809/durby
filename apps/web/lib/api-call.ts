import type { ApiErrorCode } from './auth/errors';
import { errorCode, type SessionStore } from './auth/session';
import { type ActionKey, sendAction } from './idempotency';

/**
 * Typed api calls of the signed-in pages (docs/platform/web-shell.md → Contracts). Every response
 * is parsed with the shared schema; anything else (unparseable body, network error) is `unknown`,
 * which the UI shows as the generic message. Writes go through sendAction (Idempotency-Key per
 * user action).
 */

export type Result<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode | 'unknown' };

export interface Schema<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

export type Api = Pick<SessionStore, 'apiFetch'>;

async function parsed<T>(res: Response, schema: Schema<T>): Promise<Result<T>> {
  if (!res.ok) return { ok: false, code: await errorCode(res) };
  try {
    const result = schema.safeParse(await res.json());
    return result.success ? { ok: true, data: result.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

export async function read<T>(store: Api, path: string, schema: Schema<T>): Promise<Result<T>> {
  try {
    return await parsed(await store.apiFetch(path, { cache: 'no-store' }), schema);
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

/** A write; 204 answers carry no body (`schema` omitted). */
export async function write<T = null>(
  store: Api,
  action: ActionKey,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  schema?: Schema<T>,
): Promise<Result<T | null>> {
  try {
    const res = await sendAction(store, action, path, {
      method,
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!schema)
      return res.ok ? { ok: true, data: null } : { ok: false, code: await errorCode(res) };
    return await parsed(res, schema);
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

export const list = <T>(schema: Schema<{ data: T[] }>) => ({
  safeParse: (value: unknown) => {
    const result = schema.safeParse(value);
    return result.success ? { success: true as const, data: result.data.data } : result;
  },
});
