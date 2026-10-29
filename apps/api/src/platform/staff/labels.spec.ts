import { dictionaries, LOCALES } from '@durby/i18n';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_SYSTEM_ACTORS,
  STAFF_ERROR_CODES,
  STAFF_PERMISSIONS,
  STAFF_ROLES,
  staffErrorLabel,
  staffRoleLabel,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';

// Rule 3: staff permissions, roles, audit actions and error codes are labels, in every locale.
describe('staff labels', () => {
  const keys = [
    ...Object.values(STAFF_PERMISSIONS).map((p) => p.label),
    ...STAFF_ROLES.map(staffRoleLabel),
    ...Object.values(PLATFORM_AUDIT_ACTIONS).map((a) => a.label),
    ...Object.values(PLATFORM_AUDIT_SYSTEM_ACTORS).map((a) => a.label),
    'staff.audit.entities.staffAccount',
    ...STAFF_ERROR_CODES.map(staffErrorLabel),
    'staff.email.invite.subject',
    'staff.email.invite.body',
  ];

  it.each(LOCALES)('%s has every staff label', (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string | undefined>;
    expect(keys.filter((key) => !dictionary[key])).toEqual([]);
  });
});
