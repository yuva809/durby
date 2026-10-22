import { dictionaries, LOCALES } from '@durby/i18n';
import { PERMISSIONS, SYSTEM_ROLES } from '@durby/shared';
import { describe, expect, it } from 'vitest';

// Rule 3: permission and system role names are labels, in every locale.
describe('rbac labels', () => {
  const keys = [
    ...Object.values(PERMISSIONS).map((p) => p.label),
    ...SYSTEM_ROLES.map((role) => `platform.roles.${role}`),
    'platform.email.invite.subject',
    'platform.email.invite.body',
  ];

  it.each(LOCALES)('%s has every permission, role and invitation mail label', (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string | undefined>;
    expect(keys.filter((key) => !dictionary[key])).toEqual([]);
  });
});
