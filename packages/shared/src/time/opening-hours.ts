import { z } from 'zod';
import {
  addDays,
  isLocalDate,
  isLocalTime,
  type LocalDate,
  type LocalTime,
  type Weekday,
  weekdayOf,
  WEEKDAYS,
  zonedBound,
} from './zoned';

/**
 * Weekly opening hours and closed dates of a location (settings `openingHours`, `closedDates`;
 * docs/modules/reservations.md → Settings). Windows are local wall-clock times; a window whose `to`
 * is not after its `from` runs past midnight and belongs to the day it starts.
 */

const MAX_WINDOWS_PER_DAY = 4;
const DAY_MINUTES = 24 * 60;

const localTime = z.string().refine(isLocalTime, { message: 'Expected HH:mm (00:00–23:59)' });

const hoursWindowSchema = z
  .strictObject({ from: localTime, to: localTime })
  .refine((w) => w.from !== w.to, { message: 'A window needs a length' });

export type HoursWindow = z.infer<typeof hoursWindowSchema>;

const dayWindows = z.array(hoursWindowSchema).max(MAX_WINDOWS_PER_DAY);

export const weeklyHoursSchema = z
  .strictObject({
    mon: dayWindows,
    tue: dayWindows,
    wed: dayWindows,
    thu: dayWindows,
    fri: dayWindows,
    sat: dayWindows,
    sun: dayWindows,
  })
  .refine((week) => !windowsOverlap(week), { message: 'Windows overlap' });

export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

export const closedDatesSchema = z
  .array(z.string().refine(isLocalDate, { message: 'Expected a date YYYY-MM-DD' }))
  .max(366)
  .refine((dates) => new Set(dates).size === dates.length, { message: 'Dates repeat' });

const EVERY_DAY = [{ from: '11:00', to: '23:00' }];

export const DEFAULT_OPENING_HOURS: WeeklyHours = {
  mon: EVERY_DAY,
  tue: EVERY_DAY,
  wed: EVERY_DAY,
  thu: EVERY_DAY,
  fri: EVERY_DAY,
  sat: EVERY_DAY,
  sun: EVERY_DAY,
};

/**
 * The windows that start on `date` in `timeZone`, as instants `[start, end)`. Nothing on a closed
 * date. A bound in the spring gap moves to the end of the gap; in the autumn repeat a window opens at
 * the first and closes at the last occurrence of its time.
 */
export function serviceWindowsOn(
  date: LocalDate,
  hours: WeeklyHours,
  closedDates: readonly LocalDate[],
  timeZone: string,
): { start: Date; end: Date }[] {
  if (closedDates.includes(date)) return [];
  return hours[weekdayOf(date)].map((w) => ({
    start: zonedBound(date, w.from, timeZone, 'first'),
    end: zonedBound(w.to > w.from ? date : addDays(date, 1), w.to, timeZone, 'last'),
  }));
}

const minutes = (time: LocalTime) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** A part of a day's window, as wall-clock times; `to` ≤ `from` runs past midnight. */
export interface DayWindow {
  day: Weekday;
  from: LocalTime;
  to: LocalTime;
}

/**
 * The parts of `service`'s windows that lie outside `opening`, per weekday (docs/modules/reservations.md
 * → R1.5c). Like the availability engine, each day's service windows are compared with that same
 * day's opening windows only (a window past midnight belongs to the day it starts), so whatever is
 * listed here is never offered as a slot.
 */
export function windowsOutside(service: WeeklyHours, opening: WeeklyHours): DayWindow[] {
  const span = (w: HoursWindow) => {
    const start = minutes(w.from);
    const end = minutes(w.to) > start ? minutes(w.to) : minutes(w.to) + DAY_MINUTES;
    return { start, end };
  };
  return WEEKDAYS.flatMap((day) => {
    const open = opening[day].map(span).sort((a, b) => a.start - b.start);
    return service[day].map(span).flatMap((s) => {
      const parts: { start: number; end: number }[] = [];
      let at = s.start;
      for (const o of open) {
        if (o.end <= at || o.start >= s.end) continue;
        if (o.start > at) parts.push({ start: at, end: o.start });
        at = Math.max(at, o.end);
      }
      if (at < s.end) parts.push({ start: at, end: s.end });
      return parts.map((p) => ({ day, from: clock(p.start), to: clock(p.end) }));
    });
  });
}

const clock = (minute: number): LocalTime => {
  const m = minute % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Whether any two windows of the week overlap, as minutes of a week that wraps Sunday → Monday. */
function windowsOverlap(week: Readonly<Record<Weekday, readonly HoursWindow[]>>): boolean {
  const spans = WEEKDAYS.flatMap((day, i) =>
    week[day].map((w) => {
      const start = i * DAY_MINUTES + minutes(w.from);
      const length = (minutes(w.to) - minutes(w.from) + DAY_MINUTES) % DAY_MINUTES;
      return { start, end: start + length };
    }),
  ).sort((a, b) => a.start - b.start);
  const weekEnd = WEEKDAYS.length * DAY_MINUTES;
  return spans.some(
    (s, i) =>
      (i > 0 && s.start < spans[i - 1]!.end) ||
      // Sunday night running into Monday morning.
      (s.end > weekEnd && spans[0]!.start < s.end - weekEnd),
  );
}
