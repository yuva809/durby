import { addDays, isLocalDate, REPORT_MAX_DAYS } from '@durby/shared';
import type { ReportFilter } from './api';

/** The period and location of the report pages, kept in the address so the tabs share them. */

export const PERIODS = ['today', 'yesterday', 'last7', 'last28', 'month', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

const DEFAULT_PERIOD: Period = 'last7';

export function periodOf(params: URLSearchParams): Period {
  const value = params.get('period');
  return PERIODS.find((p) => p === value) ?? DEFAULT_PERIOD;
}

/** The business days of a preset; `today` is the current business day. */
export function rangeOf(
  period: Exclude<Period, 'custom'>,
  today: string,
): { from: string; to: string } {
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'last28':
      return { from: addDays(today, -27), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** Whether the api takes this period (docs/modules/reports.md → Periods). */
export function isRange(from: string, to: string): boolean {
  return isLocalDate(from) && isLocalDate(to) && from <= to && to < addDays(from, REPORT_MAX_DAYS);
}

/** What the address asks for; null while a custom period is incomplete or not allowed. */
export function filterFromParams(params: URLSearchParams, today: string): ReportFilter | null {
  const locationId = params.get('location') || null;
  const period = periodOf(params);
  if (period !== 'custom') return { ...rangeOf(period, today), locationId };
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  return isRange(from, to) ? { from, to, locationId } : null;
}
