import { dictionaries, LOCALES } from '@durby/i18n';
import {
  NUMBER_PATTERN_PROBLEMS,
  NUMBER_SERIES,
  NUMBERING_ERROR_CODES,
  numberingErrorLabel,
  numberPatternProblemLabel,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';

// Rule 3: series names, descriptions, pattern problems and errors are labels, in every locale.
describe('numbering labels', () => {
  const keys = [
    ...Object.values(NUMBER_SERIES).flatMap((s) => [s.label, s.description]),
    ...NUMBER_PATTERN_PROBLEMS.map(numberPatternProblemLabel),
    ...NUMBERING_ERROR_CODES.map(numberingErrorLabel),
  ];

  it.each(LOCALES)('%s has every numbering label', (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string | undefined>;
    expect(keys.filter((key) => !dictionary[key])).toEqual([]);
  });
});
