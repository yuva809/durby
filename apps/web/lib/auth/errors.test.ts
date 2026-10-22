import { AUTH_ERROR_CODES } from '@durby/shared';
import { dictionaries, LOCALES } from '@durby/i18n';
import { describe, expect, it } from 'vitest';
import { errorLabel } from './errors';

describe('errorLabel', () => {
  it.each(LOCALES)('every api error code has a %s label', (locale) => {
    for (const code of [...AUTH_ERROR_CODES, 'unknown' as const]) {
      expect(dictionaries[locale][errorLabel(code)], code).toBeTruthy();
    }
  });

  it('maps codes to distinct labels, unknown to the generic one', () => {
    expect(errorLabel('auth.invalid_credentials')).toBe('auth.errors.invalidCredentials');
    expect(errorLabel('unknown')).toBe('auth.errors.generic');
    expect(new Set(AUTH_ERROR_CODES.map(errorLabel)).size).toBe(AUTH_ERROR_CODES.length);
  });
});
