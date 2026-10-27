import type {
  AuditErrorCode,
  AuthErrorCode,
  CatalogErrorCode,
  EntitlementErrorCode,
  IdempotencyErrorCode,
  InvitationErrorCode,
  LabelErrorCode,
  NumberingErrorCode,
  PosErrorCode,
  RbacErrorCode,
  SettingErrorCode,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';

/** Every stable error code the api returns to the web app. */
export type ApiErrorCode =
  | AuthErrorCode
  | RbacErrorCode
  | InvitationErrorCode
  | IdempotencyErrorCode
  | SettingErrorCode
  | LabelErrorCode
  | NumberingErrorCode
  | EntitlementErrorCode
  | AuditErrorCode
  | CatalogErrorCode
  | PosErrorCode;

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
  'idempotency.key_required': 'platform.errors.idempotencyKeyRequired',
  'idempotency.key_invalid': 'platform.errors.idempotencyKeyInvalid',
  'idempotency.key_reused': 'platform.errors.idempotencyKeyReused',
  'idempotency.request_in_progress': 'platform.errors.idempotencyRequestInProgress',
  'settings.unknown_key': 'platform.errors.settingsUnknownKey',
  'settings.scope_not_allowed': 'platform.errors.settingsScopeNotAllowed',
  'settings.invalid_value': 'platform.errors.settingsInvalidValue',
  'settings.brand_not_found': 'platform.errors.settingsBrandNotFound',
  'settings.location_not_found': 'platform.errors.settingsLocationNotFound',
  'settings.in_use': 'platform.errors.settingsInUse',
  'labels.unknown_locale': 'platform.errors.labelsUnknownLocale',
  'labels.unknown_key': 'platform.errors.labelsUnknownKey',
  'labels.not_overridable': 'platform.errors.labelsNotOverridable',
  'labels.invalid_value': 'platform.errors.labelsInvalidValue',
  'numbering.unknown_key': 'platform.errors.numberingUnknownKey',
  'numbering.invalid_prefix': 'platform.errors.numberingInvalidPrefix',
  'numbering.invalid_pattern': 'platform.errors.numberingInvalidPattern',
  'numbering.invalid_period': 'platform.errors.numberingInvalidPeriod',
  'numbering.series_in_use': 'platform.errors.numberingSeriesInUse',
  'numbering.counter_backwards': 'platform.errors.numberingCounterBackwards',
  'entitlements.feature_disabled': 'platform.errors.featureDisabled',
  'audit.cursor_invalid': 'platform.errors.auditCursorInvalid',
  'catalog.category_not_found': 'catalog.errors.categoryNotFound',
  'catalog.product_not_found': 'catalog.errors.productNotFound',
  'catalog.category_name_taken': 'catalog.errors.categoryNameTaken',
  'catalog.product_name_taken': 'catalog.errors.productNameTaken',
  'catalog.category_archived': 'catalog.errors.categoryArchived',
  'pos.table_not_found': 'pos.errors.tableNotFound',
  'pos.location_not_found': 'pos.errors.locationNotFound',
  'pos.table_name_taken': 'pos.errors.tableNameTaken',
};

export function errorLabel(code: ApiErrorCode | 'unknown'): LabelKey {
  return code === 'unknown' ? 'auth.errors.generic' : (LABELS[code] ?? 'auth.errors.generic');
}
