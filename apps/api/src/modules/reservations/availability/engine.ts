import {
  addDays,
  type LocalDate,
  serviceWindowsOn,
  turnTimeFor,
  type TurnTimes,
  type WeeklyHours,
  zonedBound,
  zonedInstant,
  zonedParts,
} from '@durby/shared';

/**
 * The availability engine (docs/modules/reservations.md → Availability engine): which slots of one
 * local day can take a party, and on which table or combination. Pure: no database and no clock
 * (`now` is an input), so it is tested with plain data; AvailabilityLoader feeds it from one query
 * batch per location and day.
 */

export type Channel = 'staff' | 'online';

export interface EngineSettings {
  openingHours: WeeklyHours;
  closedDates: readonly LocalDate[];
  serviceHours: 'openingHours' | WeeklyHours;
  slotIntervalMinutes: number;
  turnTimes: TurnTimes;
  maxCoversPerSlot: 'off' | number;
  lastBookingOffsetMinutes: number;
  instantMaxParty: 'off' | number;
}

export interface EngineTable {
  id: string;
  name: string;
  seats: number;
  sortOrder: number;
  bookingMode: 'all' | 'staff_only' | 'walk_in_only';
  minParty: number;
  /** null = the table's seats. */
  maxParty: number | null;
}

export interface EngineCombination {
  id: string;
  name: string;
  tableIds: readonly string[];
  minParty: number;
  maxParty: number;
  onlineBookable: boolean;
}

/** A booking holding tables: the loader passes pending, booked, arrived and seated ones only. */
export interface EngineBooking {
  id: string;
  status: 'pending' | 'booked' | 'arrived' | 'seated';
  partySize: number;
  start: Date;
  end: Date;
  tableIds: readonly string[];
}

/** An open pos order (PosFloorReader): a party sits at the table now. */
export interface EngineOpenOrder {
  tableId: string;
  openedAt: Date;
  covers: number | null;
}

export interface AvailabilityInput {
  date: LocalDate;
  timeZone: string;
  now: Date;
  channel: Channel;
  partySize: number;
  settings: EngineSettings;
  tables: readonly EngineTable[];
  combinations: readonly EngineCombination[];
  bookings: readonly EngineBooking[];
  openOrders: readonly EngineOpenOrder[];
}

export type Allocation =
  | { kind: 'table'; tableId: string }
  | { kind: 'combination'; combinationId: string; tableIds: string[] };

export interface Slot {
  start: string;
  end: string;
  status: 'available' | 'request' | 'full';
  reason?: 'no_table' | 'pacing';
  /** The table or combination chosen; for a request only a hint (a request holds no table). */
  allocation?: Allocation;
}

export interface AvailabilityResult {
  date: LocalDate;
  turnMinutes: number;
  closed: boolean;
  slots: Slot[];
}

interface Interval {
  start: number;
  end: number;
}

const MINUTE = 60_000;

export function availability(input: AvailabilityInput): AvailabilityResult {
  const { date, settings, partySize } = input;
  const turnMinutes = turnTimeFor(partySize, settings.turnTimes);
  if (settings.closedDates.includes(date)) return { date, turnMinutes, closed: true, slots: [] };

  const starts = slotStarts(input);
  const turn = turnMinutes * MINUTE;
  const busy = busyIntervals(input);
  const singles = candidateTables(input);
  const combinations = candidateCombinations(input);

  const slots = starts.map((start): Slot => {
    const booking: Interval = { start, end: start + turn };
    const slot = { start: new Date(start).toISOString(), end: new Date(booking.end).toISOString() };
    if (pacingExceeded(input, start)) return { ...slot, status: 'full', reason: 'pacing' };
    const allocation = allocate(booking, busy, singles, combinations);
    if (!allocation) return { ...slot, status: 'full', reason: 'no_table' };
    const request =
      input.channel === 'online' &&
      settings.instantMaxParty !== 'off' &&
      partySize > settings.instantMaxParty;
    return { ...slot, status: request ? 'request' : 'available', allocation };
  });
  return { date, turnMinutes, closed: false, slots };
}

// --- Slots ----------------------------------------------------------------------------------------

/** Slot starts of the day: wall-clock grid per window, up to the last booking, not in the past. */
function slotStarts(input: AvailabilityInput): number[] {
  const { date, timeZone, settings, now } = input;
  const interval = settings.slotIntervalMinutes;
  let windows = serviceWindowsOn(date, settings.openingHours, settings.closedDates, timeZone).map(
    toInterval,
  );
  if (settings.serviceHours !== 'openingHours') {
    const service = serviceWindowsOn(date, settings.serviceHours, [], timeZone).map(toInterval);
    windows = windows.flatMap((w) => service.flatMap((s) => intersect(w, s)));
  }
  const starts = new Set<number>();
  for (const window of windows) {
    const last = window.end - settings.lastBookingOffsetMinutes * MINUTE;
    const from = zonedParts(new Date(window.start), timeZone);
    const fromMinute = from.hour * 60 + from.minute;
    // Wall-clock steps (DST-safe): a skipped time has no instant, a repeated one its earlier one.
    for (let k = 0; ; k++) {
      const minute = fromMinute + k * interval;
      const day = Math.floor(minute / (24 * 60));
      const t = zonedInstant(addDays(from.date, day), clock(minute % (24 * 60)), timeZone);
      if (t === null) continue;
      if (t.getTime() > last) break;
      if (t.getTime() >= window.start && t.getTime() >= now.getTime()) starts.add(t.getTime());
    }
  }
  return [...starts].sort((a, b) => a - b);
}

const toInterval = (w: { start: Date; end: Date }): Interval => ({
  start: w.start.getTime(),
  end: w.end.getTime(),
});

function intersect(a: Interval, b: Interval): Interval[] {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? [{ start, end }] : [];
}

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

// --- Occupancy ------------------------------------------------------------------------------------

/**
 * Where a seated party past its end and an open pos order keep a table: until the next slot boundary
 * after `now` (on the local wall clock, from midnight) plus one interval, moving forward with `now`.
 */
function overrunEnd(input: AvailabilityInput): number {
  const { now, timeZone, settings } = input;
  const interval = settings.slotIntervalMinutes;
  const local = zonedParts(now, timeZone);
  const minute =
    local.hour * 60 + local.minute + (now.getUTCSeconds() || now.getUTCMilliseconds() ? 1 : 0);
  const ceil = Math.ceil(minute / interval) * interval;
  const day = Math.floor(ceil / (24 * 60));
  const boundary = zonedBound(addDays(local.date, day), clock(ceil % (24 * 60)), timeZone);
  return boundary.getTime() + interval * MINUTE;
}

/** Busy intervals per table, built once per call. */
function busyIntervals(input: AvailabilityInput): Map<string, Interval[]> {
  const { now, bookings, openOrders, tables, settings } = input;
  const busy = new Map<string, Interval[]>();
  const add = (tableId: string, interval: Interval) =>
    busy.set(tableId, [...(busy.get(tableId) ?? []), interval]);
  const rolling = overrunEnd(input);
  const seatedTables = new Set<string>();

  for (const booking of bookings) {
    let end = booking.end.getTime();
    if (booking.status === 'seated') {
      for (const id of booking.tableIds) seatedTables.add(id);
      // Overrun: a seated party keeps its table until it is finished.
      if (end <= now.getTime()) end = rolling;
    }
    for (const id of booking.tableIds) add(id, { start: booking.start.getTime(), end });
  }

  const seatsOf = new Map(tables.map((t) => [t.id, t.seats]));
  for (const order of openOrders) {
    if (seatedTables.has(order.tableId)) continue; // counted once, by the booking
    const size = order.covers ?? seatsOf.get(order.tableId) ?? 1;
    const turnEnd = order.openedAt.getTime() + turnTimeFor(size, settings.turnTimes) * MINUTE;
    add(order.tableId, { start: now.getTime(), end: Math.max(turnEnd, rolling) });
  }
  return busy;
}

function isFree(tableIds: readonly string[], booking: Interval, busy: Map<string, Interval[]>) {
  return tableIds.every((id) =>
    (busy.get(id) ?? []).every((b) => b.end <= booking.start || b.start >= booking.end),
  );
}

function pacingExceeded(input: AvailabilityInput, start: number): boolean {
  const limit = input.settings.maxCoversPerSlot;
  if (limit === 'off') return false;
  const end = start + input.settings.slotIntervalMinutes * MINUTE;
  const covers = input.bookings
    .filter((b) => b.start.getTime() >= start && b.start.getTime() < end)
    .reduce((sum, b) => sum + b.partySize, 0);
  return covers + input.partySize > limit;
}

// --- Candidates and choice ------------------------------------------------------------------------

const bookable = (table: EngineTable, channel: Channel) =>
  table.bookingMode === 'all' || (table.bookingMode === 'staff_only' && channel === 'staff');

const capacity = (table: EngineTable) => table.maxParty ?? table.seats;

/** Single tables that may take the party on this channel, best first. */
function candidateTables(input: AvailabilityInput): EngineTable[] {
  const { partySize, channel } = input;
  return input.tables
    .filter((t) => bookable(t, channel) && t.minParty <= partySize && partySize <= capacity(t))
    .sort(
      (a, b) =>
        capacity(a) - capacity(b) ||
        a.seats - b.seats ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

/** Combinations that may take the party on this channel, best first. */
function candidateCombinations(input: AvailabilityInput): EngineCombination[] {
  const { partySize, channel } = input;
  const tables = new Map(input.tables.map((t) => [t.id, t]));
  return input.combinations
    .filter(
      (c) =>
        c.minParty <= partySize &&
        partySize <= c.maxParty &&
        (channel === 'staff' || c.onlineBookable) &&
        c.tableIds.every((id) => {
          const table = tables.get(id);
          return table !== undefined && bookable(table, channel);
        }),
    )
    .sort(
      (a, b) =>
        a.maxParty - b.maxParty ||
        a.tableIds.length - b.tableIds.length ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

/** Single tables first; a combination only when no single table is free and fits. */
function allocate(
  booking: Interval,
  busy: Map<string, Interval[]>,
  singles: readonly EngineTable[],
  combinations: readonly EngineCombination[],
): Allocation | null {
  const table = singles.find((t) => isFree([t.id], booking, busy));
  if (table) return { kind: 'table', tableId: table.id };
  const combination = combinations.find((c) => isFree(c.tableIds, booking, busy));
  if (combination) {
    return {
      kind: 'combination',
      combinationId: combination.id,
      tableIds: [...combination.tableIds],
    };
  }
  return null;
}
