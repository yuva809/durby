import type { AuthErrorCode } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';

/** Label shown for each api error code (CLAUDE.md rule 3: no hardcoded UI text). */
const LABELS: Record<AuthErrorCode, LabelKey> = {
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
};

export function errorLabel(code: AuthErrorCode | 'unknown'): LabelKey {
  return code === 'unknown' ? 'auth.errors.generic' : (LABELS[code] ?? 'auth.errors.generic');
}
