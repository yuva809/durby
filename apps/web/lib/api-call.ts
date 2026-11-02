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

/**
 * How long a write may wait for its answer before the page gives up and shows the generic error.
 * The api bounds its own slow parts (mail has a few seconds), so a write that takes longer is
 * stuck. Giving up does not cancel the action: it may still have been applied, so the action
 * keeps its Idempotency-Key and a retry replays the stored answer instead of repeating the write.
 */
export const WRITE_TIMEOUT_MS = 30_000;

async function parsed<T>(res: Response, schema: Schema<T>): Promise<Result<T>> {
  if (!res.ok) return { ok: false, code: await errorCode(res) };
  try {
    const result = schema.safeParse(await res.json());
    return result.success ? { ok: true, data: result.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

/** The longest wait before the one retry of a busy answer (ADR 0021). */
export const BUSY_RETRY_MAX_MS = 5_000;

/** How long a 503 with Retry-After asks to wait (ms, capped); null for any other answer. */
function busyDelay(res: Response): number | null {
  if (res.status !== 503) return null;
  const header = res.headers.get('Retry-After');
  const seconds = header === null || header.trim() === '' ? NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, BUSY_RETRY_MAX_MS);
}

/**
 * Sends once more, after the Retry-After, when the api answers 503 busy (database overload, ADR
 * 0021); a second busy answer is final. A write's retry carries the same Idempotency-Key: sendAction
 * keeps the key after a 5xx, and the api never stores 5xx answers, so the write runs once.
 */
async function retryOnceIfBusy(send: () => Promise<Response>): Promise<Response> {
  const res = await send();
  const delay = busyDelay(res);
  if (delay === null) return res;
  await new Promise((resolve) => setTimeout(resolve, delay));
  return send();
}

export async function read<T>(store: Api, path: string, schema: Schema<T>): Promise<Result<T>> {
  try {
    return await parsed(
      await retryOnceIfBusy(() => store.apiFetch(path, { cache: 'no-store' })),
      schema,
    );
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
    // One deadline for both tries.
    const signal = AbortSignal.timeout(WRITE_TIMEOUT_MS);
    const res = await retryOnceIfBusy(() =>
      sendAction(store, action, path, {
        method,
        cache: 'no-store',
        signal,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    );
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
