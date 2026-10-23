import { dictionaries, LOCALES } from '@durby/i18n';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_SYSTEM_ACTORS,
  auditEntityLabel,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';

// Rule 3: action, entity type and system actor names are labels, in every locale.
describe('audit labels', () => {
  const keys = [
    ...Object.values(AUDIT_ACTIONS).map((a) => a.label),
    ...AUDIT_ENTITY_TYPES.map(auditEntityLabel),
    ...Object.values(AUDIT_SYSTEM_ACTORS).map((a) => a.label),
    'platform.errors.auditCursorInvalid',
  ];

  it.each(LOCALES)('%s has every audit label', (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string | undefined>;
    expect(keys.filter((key) => !dictionary[key])).toEqual([]);
  });
});
