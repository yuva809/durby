import {
  addDays,
  businessDay,
  type DayClock,
  type LocalDate,
  NORMAL_DAY_WEEKS,
  WEEKDAYS,
  weekdayOf,
  zonedBound,
  zonedParts,
} from '@durby/shared';

/**
 * Business days and the spans cards compare (docs/modules/reports.md → Periods, ADR 0081). A business day starts at the
 * location's `reports.dayStartsAt` in its time zone; on switch days it is 23 or 25 hours long. Pure.
 */

/** `[start, end)`. */
export interface Span {
  start: Date;
  end: Date;
}

const startOf = (day: LocalDate, clock: DayClock): Date =>
  zonedBound(day, clock.dayStartsAt, clock.timeZone);

/** The business days `from`–`to`, both included. */
export function daysSpan(from: LocalDate, to: LocalDate, clock: DayClock): Span {
  return { start: startOf(from, clock), end: startOf(addDays(to, 1), clock) };
}

/** `now`'s wall-clock time a week earlier, kept inside that business day. */
function sameTimeLastWeek(now: Date, clock: DayClock): Date {
  const local = zonedParts(now, clock.timeZone);
  const at = zonedBound(addDays(local.date, -7), local.time, clock.timeZone);
  const day = addDays(businessDay(now, clock), -7);
  const { start, end } = daysSpan(day, day, clock);
  return new Date(Math.min(Math.max(at.getTime(), start.getTime()), end.getTime()));
}

/** Monday of the week the business day is in. */
export function weekStart(day: LocalDate): LocalDate {
  return addDays(day, -WEEKDAYS.indexOf(weekdayOf(day)));
}

export interface CardSpans {
  figures: Span;
  compare: Span;
}

/** What the sales cards count at `now`, and what they compare it with. */
export function cardSpans(
  now: Date,
  clock: DayClock,
): Record<'today' | 'yesterday' | 'week', CardSpans> {
  const today = businessDay(now, clock);
  const yesterday = addDays(today, -1);
  const monday = weekStart(today);
  const lastWeekNow = sameTimeLastWeek(now, clock);
  return {
    today: {
      figures: { start: startOf(today, clock), end: now },
      compare: { start: startOf(addDays(today, -7), clock), end: lastWeekNow },
    },
    yesterday: {
      figures: daysSpan(yesterday, yesterday, clock),
      compare: daysSpan(addDays(yesterday, -7), addDays(yesterday, -7), clock),
    },
    week: {
      figures: { start: startOf(monday, clock), end: now },
      compare: { start: startOf(addDays(monday, -7), clock), end: lastWeekNow },
    },
  };
}

/** The last whole business day, and the same weekdays its normal day is averaged from (ADR 0082), latest first. */
export function normalDay(
  now: Date,
  clock: DayClock,
): { day: LocalDate; yesterday: Span; before: Span[] } {
  const day = addDays(businessDay(now, clock), -1);
  return {
    day,
    yesterday: daysSpan(day, day, clock),
    before: Array.from({ length: NORMAL_DAY_WEEKS }, (_, week) => {
      const same = addDays(day, -7 * (week + 1));
      return daysSpan(same, same, clock);
    }),
  };
}
