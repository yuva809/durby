import {
  acceptInvitationResponseSchema,
  type InvitationPreview,
  invitationPreviewSchema,
} from '@durby/shared';
import type { ApiErrorCode } from '../auth/errors';
import { errorCode, type SessionStore } from '../auth/session';

/** Accepting an invitation (docs/platform/rbac.md → Web). */

export const INVITATIONS_API = '/api/v1/invitations';

export type Result<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode | 'unknown' };

/**
 * The token of an invitation link (`/accept-invite#token=<organization id>.<secret>`). Like the
 * reset link it travels in the fragment, which the browser never sends to a server.
 */
export function invitationTokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token !== null && /^[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

async function post<T>(
  fetchImpl: typeof fetch,
  path: string,
  body: unknown,
  parse: (json: unknown) => T | null,
  headers: HeadersInit = {},
): Promise<Result<T>> {
  try {
    const res = await fetchImpl(`${INVITATIONS_API}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, code: await errorCode(res) };
    const data = parse(await res.json());
    return data === null ? { ok: false, code: 'unknown' } : { ok: true, data };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

const parseWith =
  <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) =>
  (json: unknown): T | null => {
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  };

export function previewInvitation(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<InvitationPreview>> {
  return post(fetchImpl, '/preview', { token }, parseWith(invitationPreviewSchema));
}

/** Switches the session to the organization the user just joined, if it isn't active already. */
async function activate(store: SessionStore, organizationId: string): Promise<Result<string>> {
  if (store.get()?.activeOrganizationId === organizationId)
    return { ok: true, data: organizationId };
  const switched = await store.switchOrganization(organizationId);
  return switched.ok ? { ok: true, data: organizationId } : switched;
}

/**
 * A new user: accepts with a new password, signs in with it and switches to the organization.
 * `invitations.sign_in_required` means the email has an account after all.
 */
export async function joinAsNewUser(
  store: SessionStore,
  input: { token: string; email: string; password: string; locale: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string>> {
  const accepted = await post(
    fetchImpl,
    '/accept',
    { token: input.token, password: input.password, locale: input.locale },
    parseWith(acceptInvitationResponseSchema),
  );
  if (!accepted.ok) return accepted;
  const login = await store.login(input.email, input.password);
  if (!login.ok) return login;
  return activate(store, accepted.data.organizationId);
}

/** The signed-in user accepts (their email must be the invited one) and switches to it. */
export async function joinAsSignedIn(store: SessionStore, token: string): Promise<Result<string>> {
  try {
    const res = await store.apiFetch(`${INVITATIONS_API}/accept-signed-in`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return { ok: false, code: await errorCode(res) };
    const parsed = acceptInvitationResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, code: 'unknown' };
    return activate(store, parsed.data.organizationId);
  } catch {
    return { ok: false, code: 'unknown' };
  }
}
