import { dictionaries, LOCALES } from '@durby/i18n';
import { FEATURES, PLAN_KEYS, planLabel } from '@durby/shared';
import { describe, expect, it } from 'vitest';

// Rule 3: feature and plan names, descriptions and the error are labels, in every locale.
describe('entitlement labels', () => {
  const keys = [
    ...Object.values(FEATURES).flatMap((f) => [f.label, f.description]),
    ...PLAN_KEYS.map(planLabel),
    'platform.errors.featureDisabled',
  ];

  it.each(LOCALES)('%s has every entitlement label', (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string | undefined>;
    expect(keys.filter((key) => !dictionary[key])).toEqual([]);
  });
});
