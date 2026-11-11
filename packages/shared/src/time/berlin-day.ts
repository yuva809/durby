import { addDays, isLocalDate, type LocalDate, zonedBound, zonedParts } from './zoned';

/**
 * Feature override expiry (admin portal 1d): staff pick a day, and the override ends with that day
 * on Durby's wall clock, Europe/Berlin, whatever the customer's own zone. Stored as an instant.
 */
export const EXPIRY_TIME_ZONE = 'Europe/Berlin';

/** The last instant of `day` in Berlin (23:59:59.999 local): the next day's start minus 1 ms. */
export function berlinEndOfDay(day: LocalDate): Date {
  if (!isLocalDate(day)) throw new RangeError(`Not a date: ${day}`);
  return new Date(zonedBound(addDays(day, 1), '00:00', EXPIRY_TIME_ZONE).getTime() - 1);
}

/** The Berlin calendar day of an instant, e.g. to show a stored expiry as the day staff chose. */
export function berlinDate(at: Date): LocalDate {
  return zonedParts(at, EXPIRY_TIME_ZONE).date;
}

/** Whether `day` lies before today in Berlin (an expiry on today is still allowed). */
export function isPastBerlinDay(day: LocalDate, now: Date = new Date()): boolean {
  return day < berlinDate(now);
}
