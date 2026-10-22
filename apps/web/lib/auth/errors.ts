import type { AuthErrorCode, InvitationErrorCode, RbacErrorCode } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';

/** Every stable error code the api returns to the web app. */
export type ApiErrorCode = AuthErrorCode | RbacErrorCode | InvitationErrorCode;

/** Label shown for each api error code (CLAUDE.md rule 3: no hardcoded UI text). */
const LABELS: Record<ApiErrorCode, LabelKey> = {
  'auth.unauthenticated': 'auth.errors.unauthenticated',
  'auth.invalid_credentials': 'auth.errors.invalidCredentials',
  'auth.email_not_verified': 'auth.errors.emailNotVerified',
  'auth.too_many_attempts': 'auth.errors.tooManyAttempts',
  'auth.rate_limited': 'auth.errors.rateLimited',
  'auth.refresh_invalid': 'auth.errors.refreshInvalid',
  'auth.refresh_reused': 'auth.errors.refreshReused',
  'auth.not_a_member': 'auth.errors.notAMember',
  'auth.origin_rejected': 'auth.errors.originRejected',
  'auth.token_invalid': 'auth.errors.tokenInvalid',
  'auth.unavailable': 'auth.errors.unavailable',
  'tenancy.context_missing': 'auth.errors.contextMissing',
  'validation.failed': 'auth.errors.validationFailed',
  'rbac.permission_denied': 'platform.errors.permissionDenied',
  'rbac.platform_only': 'platform.errors.platformOnly',
  'rbac.route_unmarked': 'platform.errors.routeUnmarked',
  'rbac.not_grantable': 'platform.errors.notGrantable',
  'rbac.cannot_change_self': 'platform.errors.cannotChangeSelf',
  'rbac.last_owner': 'platform.errors.lastOwner',
  'rbac.owner_all_locations': 'platform.errors.ownerAllLocations',
  'rbac.role_not_found': 'platform.errors.roleNotFound',
  'rbac.member_not_found': 'platform.errors.memberNotFound',
  'rbac.location_not_found': 'platform.errors.locationNotFound',
  'rbac.invitation_not_found': 'platform.errors.invitationNotFound',
  'rbac.permission_unknown': 'platform.errors.permissionUnknown',
  'rbac.system_role_immutable': 'platform.errors.systemRoleImmutable',
  'rbac.role_in_use': 'platform.errors.roleInUse',
  'rbac.role_name_taken': 'platform.errors.roleNameTaken',
  'invitations.already_member': 'platform.invite.errors.alreadyMember',
  'invitations.sign_in_required': 'platform.invite.errors.signInRequired',
  'invitations.email_mismatch': 'platform.invite.errors.emailMismatch',
};

export function errorLabel(code: ApiErrorCode | 'unknown'): LabelKey {
  return code === 'unknown' ? 'auth.errors.generic' : (LABELS[code] ?? 'auth.errors.generic');
}
