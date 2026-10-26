import { isLabelKey, type LabelKey } from '@durby/i18n';
import {
  counterValueSchema,
  formatNumber,
  type NumberFormat,
  numberFormatProblems,
  numberPatternProblemLabel,
  type NumberSeries,
  numberSeriesLabelBase,
} from '@durby/shared';

/**
 * The number series editor's rules (docs/platform/web-shell.md → Number series): pattern problems
 * and live preview with the shared rules the api applies, and the raise-only counter.
 */

/** Label keys of the format's problems, in the shared order; empty when valid. */
export function formatProblemLabels(format: NumberFormat): LabelKey[] {
  return numberFormatProblems(format)
    .map(numberPatternProblemLabel)
    .filter((key): key is LabelKey => isLabelKey(key));
}

/**
 * The number `nextValue` would get with `format`, in the series' current period (its year when
 * the period is a year; else the current year), or null while the format has problems.
 */
export function livePreview(
  format: NumberFormat,
  series: Pick<NumberSeries, 'period' | 'nextValue'>,
  now: Date = new Date(),
): string | null {
  if (numberFormatProblems(format).length > 0) return null;
  const year = /^[0-9]{4}$/.test(series.period) ? Number(series.period) : now.getFullYear();
  return formatNumber(format.pattern, {
    prefix: format.prefix,
    year,
    month: now.getMonth() + 1,
    sequence: BigInt(series.nextValue),
  });
}

export type CounterProblem = 'format' | 'notHigher';

/**
 * Why `wanted` can't be the next number, or null. Counters only move forward (ADR 0012): the
 * value must be digits within bigint and greater than the current one, compared as BigInt.
 */
export function counterProblem(current: string, wanted: string): CounterProblem | null {
  if (!counterValueSchema.safeParse(wanted).success) return 'format';
  return BigInt(wanted) > BigInt(current) ? null : 'notHigher';
}

export const seriesLabels = (key: string) => {
  const base = numberSeriesLabelBase(key);
  const name = `${base}.name`;
  const description = `${base}.description`;
  return {
    name: isLabelKey(name) ? name : null,
    description: isLabelKey(description) ? description : null,
  };
};
