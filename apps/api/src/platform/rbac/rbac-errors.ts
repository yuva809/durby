import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../http';

/** Error codes of platform/rbac (docs/platform/rbac.md → Error codes). */
export const rbacErrors = {
  permissionDenied: (permission: string) =>
    new ApiError(HttpStatus.FORBIDDEN, 'rbac.permission_denied', 'Permission denied.', {
      permission,
    }),
  platformOnly: () =>
    new ApiError(HttpStatus.FORBIDDEN, 'rbac.platform_only', 'Only for platform staff.'),
  routeUnmarked: () =>
    new ApiError(HttpStatus.FORBIDDEN, 'rbac.route_unmarked', 'Route has no access marker.'),
  notGrantable: () =>
    new ApiError(
      HttpStatus.FORBIDDEN,
      'rbac.not_grantable',
      'You can only grant or manage what your own role allows.',
    ),
  cannotChangeSelf: () =>
    new ApiError(
      HttpStatus.FORBIDDEN,
      'rbac.cannot_change_self',
      'You cannot change or remove your own membership.',
    ),
  lastOwner: () =>
    new ApiError(HttpStatus.CONFLICT, 'rbac.last_owner', 'The organization needs an owner.'),
  ownerAllLocations: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'rbac.owner_all_locations',
      'An owner always covers all locations.',
    ),
  roleNotFound: () => new ApiError(HttpStatus.NOT_FOUND, 'rbac.role_not_found', 'Role not found.'),
  memberNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'rbac.member_not_found', 'Member not found.'),
  locationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'rbac.location_not_found', 'Location not found.'),
  invitationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'rbac.invitation_not_found', 'Invitation not found.'),
  permissionUnknown: (keys: string[]) =>
    new ApiError(HttpStatus.BAD_REQUEST, 'rbac.permission_unknown', 'Unknown permission keys.', {
      keys,
    }),
  systemRoleImmutable: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'rbac.system_role_immutable',
      'System roles cannot be changed or deleted.',
    ),
  roleInUse: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'rbac.role_in_use',
      'The role is assigned to members or open invitations.',
    ),
  alreadyMember: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'invitations.already_member',
      'This email belongs to a member already.',
    ),
  signInRequired: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'invitations.sign_in_required',
      'An account exists for this email: sign in to accept.',
    ),
  emailMismatch: () =>
    new ApiError(
      HttpStatus.FORBIDDEN,
      'invitations.email_mismatch',
      'The invitation is for another email address.',
    ),
  roleNameTaken: () =>
    new ApiError(HttpStatus.CONFLICT, 'rbac.role_name_taken', 'A role with this name exists.'),
} as const;

/** The deferred last-Owner trigger (memberships_keep_last_owner) rejected the commit. */
export function isLastOwnerViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes('would have no owner')) return true;
  }
  return false;
}

/** A unique constraint (Prisma P2002) failed. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
