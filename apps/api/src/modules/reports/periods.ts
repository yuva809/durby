import {
  addDays,
  type LocalDate,
  WEEKDAYS,
  weekdayOf,
  zonedBound,
  zonedParts,
} from '@durby/shared';

/**
 * Business days and the spans cards compare (docs/modules/reports.md → Periods, ADR 0081). A business day starts at the
 * location's `reports.dayStartsAt` in its time zone; on switch days it is 23 or 25 hours long. Pure.
 */

/** Where a location's days start. */
export interface DayClock {
  timeZone: string;
  /** `HH:mm`. */
  dayStartsAt: string;
}

/** `[start, end)`. */
export interface Span {
  start: Date;
  end: Date;
}

/** The business day `at` belongs to: before the day's start it is still the day before. */
export function businessDay(at: Date, clock: DayClock): LocalDate {
  const local = zonedParts(at, clock.timeZone);
  return local.time < clock.dayStartsAt ? addDays(local.date, -1) : local.date;
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
