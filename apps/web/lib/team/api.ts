import {
  type CreateTeamMemberRequest,
  createTeamMemberResponseSchema,
  invitationLinkResponseSchema,
  type SetMemberPasswordRequest,
  teamListResponseSchema,
  teamMemberSchema,
  type UpdateTeamMemberRequest,
} from '@durby/shared';
import { read, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of the Manage Staff page (docs/platform/rbac.md → Manage Staff), parsed with the shared schemas. */

type Api = Parameters<typeof read>[0];

export const loadTeam = (store: Api) => read(store, '/api/v1/staff', teamListResponseSchema);

export const createTeamMember = (store: Api, action: ActionKey, body: CreateTeamMemberRequest) =>
  write(store, action, '/api/v1/staff', 'POST', body, createTeamMemberResponseSchema);

export const updateTeamMember = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateTeamMemberRequest,
) => write(store, action, `/api/v1/staff/${id}`, 'PATCH', body, teamMemberSchema);

export const setTeamMemberActive = (store: Api, action: ActionKey, id: string, active: boolean) =>
  write(
    store,
    action,
    `/api/v1/staff/${id}/${active ? 'reactivate' : 'deactivate'}`,
    'POST',
    undefined,
    teamMemberSchema,
  );

/** A fresh invitation link (the previous one stops working). */
export const renewInvitationLink = (store: Api, action: ActionKey, invitationId: string) =>
  write(
    store,
    action,
    `/api/v1/invitations/${invitationId}/link`,
    'POST',
    undefined,
    invitationLinkResponseSchema,
  );

/** Sets a member's password for them (ADR 0052): final or temporary as the organization's setting says. */
export const setTeamMemberPassword = (
  store: Api,
  action: ActionKey,
  id: string,
  body: SetMemberPasswordRequest,
) => write(store, action, `/api/v1/staff/${id}/password`, 'POST', body, teamMemberSchema);
