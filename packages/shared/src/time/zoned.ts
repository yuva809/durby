/**
 * Wall-clock time in an IANA time zone, DST-safe, with `Intl` only (no date library). Durby stores
 * instants in UTC; opening hours, booking slots, number-series years and day filters are local
 * wall-clock times of a location or organization (`timezone` setting). See docs/modules/reservations.md.
 *
 * A local date is `YYYY-MM-DD`, a local time `HH:mm` (00:00–23:59). Around a DST switch a wall time
 * can have no instant (spring forward) or two (fall back); `zonedInstants` returns all of them and
 * callers decide.
 */

export type LocalDate = string;
export type LocalTime = string;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface ZonedParts {
  date: LocalDate;
  time: LocalTime;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

/** Whether `value` is a real calendar date `YYYY-MM-DD`. */
export function isLocalDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Whether `value` is a wall-clock time `HH:mm` from 00:00 to 23:59. */
export function isLocalTime(value: string): boolean {
  return TIME.test(value);
}

/** `date` plus `days` calendar days (negative goes back). */
export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(dateUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The weekday of a calendar date (independent of any zone). */
export function weekdayOf(date: LocalDate): Weekday {
  // getUTCDay: 0 = Sunday.
  return WEEKDAYS[(new Date(dateUtcMs(date)).getUTCDay() + 6) % 7]!;
}

/** Date, time and weekday of `at` on the wall clock of `timeZone`. */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const f = fields(at.getTime(), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${f.year}-${pad(f.month)}-${pad(f.day)}`;
  return {
    date,
    time: `${pad(f.hour)}:${pad(f.minute)}`,
    year: f.year,
    month: f.month,
    day: f.day,
    hour: f.hour,
    minute: f.minute,
    weekday: weekdayOf(date),
  };
}

/**
 * Every instant at which the wall clock of `timeZone` shows `date` `time`, earliest first: none in a
 * spring-forward gap, two in a fall-back repeat, otherwise one. Throws RangeError on a malformed
 * date or time or an unknown zone.
 */
export function zonedInstants(date: LocalDate, time: LocalTime, timeZone: string): Date[] {
  const local = localUtcMs(date, time);
  return candidateOffsets(local, timeZone)
    .map((offset) => local - offset)
    .filter((instant) => offsetMs(instant, timeZone) === local - instant)
    .sort((a, b) => a - b)
    .filter((instant, i, all) => i === 0 || instant !== all[i - 1])
    .map((instant) => new Date(instant));
}

/** The earlier instant of `date` `time` in `timeZone`, or null if that wall time doesn't exist. */
export function zonedInstant(date: LocalDate, time: LocalTime, timeZone: string): Date | null {
  return zonedInstants(date, time, timeZone)[0] ?? null;
}

/**
 * `date` `time` as a bound (opening, closing, day start): `which` of its instants in a repeat, and
 * the end of the gap when the wall time is skipped, i.e. the first instant the clock shows a later
 * time. Never null.
 */
export function zonedBound(
  date: LocalDate,
  time: LocalTime,
  timeZone: string,
  which: 'first' | 'last' = 'first',
): Date {
  const instants = zonedInstants(date, time, timeZone);
  const found = which === 'first' ? instants[0] : instants.at(-1);
  if (found) return found;
  // Skipped: the gap ends at the switch, which lies between the wall time read with the later
  // (larger) offset, still before the switch, and read with the earlier one, already after it.
  const local = localUtcMs(date, time);
  const offsets = candidateOffsets(local, timeZone);
  const before = offsetMs(local - Math.max(...offsets), timeZone);
  let lo = local - Math.max(...offsets);
  let hi = local - Math.min(...offsets);
  // Bisect to the millisecond: hi ends as the first instant with the new offset.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMs(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

/**
 * The instants a calendar day starts and ends in `timeZone`, `[start, end)`: 23 or 25 hours long on
 * DST switch days. If midnight falls in a gap, the day starts when the gap ends.
 */
export function zonedDayBounds(date: LocalDate, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedBound(date, '00:00', timeZone),
    end: zonedBound(addDays(date, 1), '00:00', timeZone),
  };
}

/**
 * Offsets that may apply near the wall time `local` (read as if UTC): those a day before and after.
 * Real zones change their offset at most once within two days, so the true offset is among them.
 */
function candidateOffsets(local: number, timeZone: string): number[] {
  return [...new Set([offsetMs(local - DAY_MS, timeZone), offsetMs(local + DAY_MS, timeZone)])];
}

function dateUtcMs(date: LocalDate): number {
  if (!isLocalDate(date)) throw new RangeError(`Not a date (YYYY-MM-DD): ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** The wall time read as if it were UTC, in ms. */
function localUtcMs(date: LocalDate, time: LocalTime): number {
  if (!isLocalTime(time)) throw new RangeError(`Not a time (HH:mm): ${time}`);
  const [h, min] = time.split(':').map(Number) as [number, number];
  return dateUtcMs(date) + (h * 60 + min) * 60_000;
}

/** Offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich), to the second. */
function offsetMs(instant: number, timeZone: string): number {
  const f = fields(instant, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone. h23: midnight is 00, never 24.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function fields(instant: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}
