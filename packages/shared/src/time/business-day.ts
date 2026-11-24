import { addDays, type LocalDate, type LocalTime, zonedParts } from './zoned';

/** Where a location's business days start (ADR 0081): its zone and the wall-clock time. */
export interface DayClock {
  timeZone: string;
  dayStartsAt: LocalTime;
}

/** The business day `at` belongs to: before the day's start it is still the day before. */
export function businessDay(at: Date, clock: DayClock): LocalDate {
  const local = zonedParts(at, clock.timeZone);
  return local.time < clock.dayStartsAt ? addDays(local.date, -1) : local.date;
}
