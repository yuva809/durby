import { AUTH_API, type AuthResult, errorCode } from './session';

/** Unauthenticated auth requests (forgot, reset, verify). They never touch the session. */
export async function postPublic(
  path: '/password/forgot' | '/password/reset' | '/verify-email',
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthResult> {
  try {
    const res = await fetchImpl(`${AUTH_API}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? { ok: true } : { ok: false, code: await errorCode(res) };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

/**
 * The token of an emailed link (`/reset-password#token=…`). It travels in the fragment, which the
 * browser never sends to a server; pages remove it from the address bar once read.
 */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token !== null && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
