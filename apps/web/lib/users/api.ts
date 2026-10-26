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
import { list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

export type { Result } from '../api-call';

/**
 * Calls of the members, invitations and roles pages (docs/platform/rbac.md → Endpoints), through
 * the parsed, idempotent helpers of lib/api-call.ts.
 */

type Api = Parameters<typeof read>[0];

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
