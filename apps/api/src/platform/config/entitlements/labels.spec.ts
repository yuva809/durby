import { dictionaries, LOCALES } from '@durby/i18n';
import { type FeatureDefinition, FEATURES, PLAN_KEYS, planLabel } from '@durby/shared';
import { describe, expect, it } from 'vitest';

/** Label keys of a registry that a dictionary lacks. */
function missingFeatureLabels(
  registry: Readonly<Record<string, Pick<FeatureDefinition, 'label' | 'description'>>>,
  dictionary: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.values(registry)
    .flatMap((f) => [f.label, f.description])
    .filter((key) => !dictionary[key]);
}

// Rule 3: feature and plan names, descriptions and the error are labels, in every locale. The staff
// portal renders module switches from these labels (admin portal 1d), so a key without them fails.
describe('entitlement labels', () => {
  const keys = [...PLAN_KEYS.map(planLabel), 'platform.errors.featureDisabled'];

  it.each(LOCALES)('%s has every entitlement label', (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string | undefined>;
    expect(missingFeatureLabels(FEATURES, dictionary)).toEqual([]);
    expect(keys.filter((key) => !dictionary[key])).toEqual([]);
  });

  it('catches a feature key without labels', () => {
    const dictionary = dictionaries.en as Record<string, string | undefined>;
    const fake = {
      'fake.module': {
        label: 'platform.features.fakeModule.name',
        description: 'platform.features.fakeModule.description',
      },
    };
    expect(missingFeatureLabels(fake, dictionary)).toEqual([
      'platform.features.fakeModule.name',
      'platform.features.fakeModule.description',
    ]);
  });
});
