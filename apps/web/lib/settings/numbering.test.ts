import { dictionaries, LOCALES } from '@durby/i18n';
import {
  NUMBER_PATTERN_PROBLEMS,
  NUMBER_SERIES_KEYS,
  numberPatternProblemLabel,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { counterProblem, formatProblemLabels, livePreview, seriesLabels } from './numbering';

const series = { period: '2026', nextValue: '42' };
const at = new Date(2026, 2, 15);

describe('number series editor', () => {
  it('previews the next number live with the edited format', () => {
    expect(
      livePreview(
        { prefix: 'INV', pattern: '{prefix}-{YYYY}-{seq:6}', resetPolicy: 'yearly' },
        series,
        at,
      ),
    ).toBe('INV-2026-000042');
    expect(
      livePreview(
        { prefix: 'RE', pattern: '{prefix}{YY}{MM}/{seq:4}', resetPolicy: 'yearly' },
        series,
        at,
      ),
    ).toBe('RE2603/0042');
    expect(
      livePreview(
        { prefix: 'X', pattern: '{prefix}{seq:3}', resetPolicy: 'never' },
        { period: 'all', nextValue: '7' },
        at,
      ),
    ).toBe('X007');
  });

  it('shows no preview and labelled problems while the format is invalid', () => {
    const format = { prefix: 'IN V', pattern: '{prefix}-{YYYY}', resetPolicy: 'yearly' } as const;
    expect(livePreview(format, series, at)).toBeNull();
    expect(formatProblemLabels(format)).toEqual([
      'platform.numbering.problems.prefixInvalid',
      'platform.numbering.problems.seqMissing',
    ]);
    expect(
      formatProblemLabels({ prefix: 'PO', pattern: '{prefix}-{seq:6}', resetPolicy: 'yearly' }),
    ).toEqual(['platform.numbering.problems.yearRequired']);
  });

  it('has an en and de label for every problem and series', () => {
    for (const locale of LOCALES) {
      for (const problem of NUMBER_PATTERN_PROBLEMS) {
        expect(
          dictionaries[locale][numberPatternProblemLabel(problem) as keyof typeof dictionaries.en],
        ).toBeTruthy();
      }
      for (const key of NUMBER_SERIES_KEYS) {
        expect(seriesLabels(key).name).not.toBeNull();
        expect(seriesLabels(key).description).not.toBeNull();
      }
    }
  });

  it('only raises the counter, compared as BigInt beyond Number precision', () => {
    expect(counterProblem('42', '43')).toBeNull();
    expect(counterProblem('42', '42')).toBe('notHigher');
    expect(counterProblem('42', '9')).toBe('notHigher');
    expect(counterProblem('9007199254740993', '9007199254740992')).toBe('notHigher');
    expect(counterProblem('9007199254740992', '9007199254740993')).toBeNull();
    for (const bad of ['', '0', '-1', '1.5', 'abc', '01', '9223372036854775808']) {
      expect(counterProblem('1', bad), bad).toBe('format');
    }
  });
});
