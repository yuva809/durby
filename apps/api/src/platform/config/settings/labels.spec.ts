import { dictionaries, LOCALES } from '@durby/i18n';
import { SETTING_ERROR_CODES, SETTINGS, settingErrorLabel } from '@durby/shared';
import { describe, expect, it } from 'vitest';

// Rule 3: setting names, descriptions and errors are labels, in every locale.
describe('settings labels', () => {
  const keys = [
    ...Object.values(SETTINGS).flatMap((s) => [s.label, s.description]),
    ...SETTING_ERROR_CODES.map(settingErrorLabel),
  ];

  it.each(LOCALES)('%s has every settings label', (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string | undefined>;
    expect(keys.filter((key) => !dictionary[key])).toEqual([]);
  });
});
