import {
  AUDIT_ERROR_CODES,
  AUTH_ERROR_CODES,
  ENTITLEMENT_ERROR_CODES,
  IDEMPOTENCY_ERROR_CODES,
  INVITATION_ERROR_CODES,
  LABEL_ERROR_CODES,
  NUMBERING_ERROR_CODES,
  RBAC_ERROR_CODES,
  SETTING_ERROR_CODES,
} from '@durby/shared';
import { dictionaries, LOCALES } from '@durby/i18n';
import { describe, expect, it } from 'vitest';
import { errorLabel } from './errors';

const CODES = [
  ...AUTH_ERROR_CODES,
  ...RBAC_ERROR_CODES,
  ...INVITATION_ERROR_CODES,
  ...IDEMPOTENCY_ERROR_CODES,
  ...SETTING_ERROR_CODES,
  ...LABEL_ERROR_CODES,
  ...NUMBERING_ERROR_CODES,
  ...ENTITLEMENT_ERROR_CODES,
  ...AUDIT_ERROR_CODES,
];

describe('errorLabel', () => {
  it.each(LOCALES)('every api error code has a %s label', (locale) => {
    for (const code of [...CODES, 'unknown' as const]) {
      expect(dictionaries[locale][errorLabel(code)], code).toBeTruthy();
    }
  });

  it('maps codes to distinct labels, unknown to the generic one', () => {
    expect(errorLabel('auth.invalid_credentials')).toBe('auth.errors.invalidCredentials');
    expect(errorLabel('invitations.sign_in_required')).toBe(
      'platform.invite.errors.signInRequired',
    );
    expect(errorLabel('unknown')).toBe('auth.errors.generic');
    expect(new Set(CODES.map(errorLabel)).size).toBe(CODES.length);
  });
});
