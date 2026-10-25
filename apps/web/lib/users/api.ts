import {
  type CreateInvitationRequest,
  type CreateRoleRequest,
  type Invitation,
  invitationListResponseSchema,
  invitationSchema,
  type LocationSummary,
  locationListResponseSchema,
  type Member,
  memberListResponseSchema,
  memberSchema,
  type Role,
  roleListResponseSchema,
  roleSchema,
  type UpdateMemberRequest,
  type UpdateRoleRequest,
} from '@durby/shared';
import type { ApiErrorCode } from '../auth/errors';
import { errorCode, type SessionStore } from '../auth/session';
import { type ActionKey, sendAction } from '../idempotency';

/**
 * Calls of the members, invitations and roles pages (docs/platform/rbac.md → Endpoints). Every
 * response is parsed with the shared schema; anything else (unparseable body, network error) is
 * `unknown`, which the UI shows as the generic message. Writes go through sendAction.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode | 'unknown' };

interface Schema<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

type Api = Pick<SessionStore, 'apiFetch'>;

async function parsed<T>(res: Response, schema: Schema<T>): Promise<Result<T>> {
  if (!res.ok) return { ok: false, code: await errorCode(res) };
  try {
    const result = schema.safeParse(await res.json());
    return result.success ? { ok: true, data: result.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

async function read<T>(store: Api, path: string, schema: Schema<T>): Promise<Result<T>> {
  try {
    return await parsed(await store.apiFetch(path, { cache: 'no-store' }), schema);
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

/** A write; 204 answers carry no body (`schema` omitted). */
async function write<T = null>(
  store: Api,
  action: ActionKey,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
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

const list = <T>(schema: Schema<{ data: T[] }>) => ({
  safeParse: (value: unknown) => {
    const result = schema.safeParse(value);
    return result.success ? { success: true as const, data: result.data.data } : result;
  },
});

export const loadMembers = (store: Api): Promise<Result<Member[]>> =>
  read(store, '/api/v1/members', list(memberListResponseSchema));

export const loadInvitations = (store: Api): Promise<Result<Invitation[]>> =>
  read(store, '/api/v1/invitations', list(invitationListResponseSchema));

export const loadRoles = (store: Api): Promise<Result<Role[]>> =>
  read(store, '/api/v1/roles', list(roleListResponseSchema));

export const loadLocations = (store: Api): Promise<Result<LocationSummary[]>> =>
  read(store, '/api/v1/locations', list(locationListResponseSchema));

export const updateMember = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateMemberRequest,
) => write(store, action, `/api/v1/members/${id}`, 'PATCH', body, memberSchema);

export const removeMember = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `/api/v1/members/${id}`, 'DELETE');

export const createInvitation = (store: Api, action: ActionKey, body: CreateInvitationRequest) =>
  write(store, action, '/api/v1/invitations', 'POST', body, invitationSchema);

export const revokeInvitation = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `/api/v1/invitations/${id}`, 'DELETE');

export const createRole = (store: Api, action: ActionKey, body: CreateRoleRequest) =>
  write(store, action, '/api/v1/roles', 'POST', body, roleSchema);

export const updateRole = (store: Api, action: ActionKey, id: string, body: UpdateRoleRequest) =>
  write(store, action, `/api/v1/roles/${id}`, 'PATCH', body, roleSchema);

export const deleteRole = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `/api/v1/roles/${id}`, 'DELETE');
