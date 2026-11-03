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

export interface Interval {
  start: number;
  end: number;
}

/** A table's busy time: a booking's own period, or occupancy (an open order, a party overrunning). */
interface Busy extends Interval {
  kind: 'booking' | 'occupied';
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
  const { timeZone, settings, now } = input;
  const interval = settings.slotIntervalMinutes;
  const starts = new Set<number>();
  for (const window of serviceWindows(input)) {
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

/** The day's opening windows, narrowed by the reservation hours (they only intersect). */
export function serviceWindows(input: {
  date: LocalDate;
  timeZone: string;
  settings: Pick<EngineSettings, 'openingHours' | 'closedDates' | 'serviceHours'>;
}): Interval[] {
  const { date, timeZone, settings } = input;
  const windows = serviceWindowsOn(date, settings.openingHours, settings.closedDates, timeZone).map(
    toInterval,
  );
  if (settings.serviceHours === 'openingHours') return windows;
  const service = serviceWindowsOn(date, settings.serviceHours, [], timeZone).map(toInterval);
  return windows.flatMap((w) => service.flatMap((s) => intersect(w, s)));
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
  return rollingEnd(input.now, input.timeZone, input.settings.slotIntervalMinutes);
}

/** The rolling end of occupancy at `now` (overrunEnd); the host floor uses it too. */
export function rollingEnd(now: Date, timeZone: string, interval: number): number {
  const local = zonedParts(now, timeZone);
  const minute =
    local.hour * 60 + local.minute + (now.getUTCSeconds() || now.getUTCMilliseconds() ? 1 : 0);
  const ceil = Math.ceil(minute / interval) * interval;
  const day = Math.floor(ceil / (24 * 60));
  const boundary = zonedBound(addDays(local.date, day), clock(ceil % (24 * 60)), timeZone);
  return boundary.getTime() + interval * MINUTE;
}

/** Busy intervals per table, built once per call. */
function busyIntervals(input: AvailabilityInput): Map<string, Busy[]> {
  const { now, bookings, openOrders, tables, settings } = input;
  const busy = new Map<string, Busy[]>();
  const add = (tableId: string, interval: Busy) =>
    busy.set(tableId, [...(busy.get(tableId) ?? []), interval]);
  const rolling = overrunEnd(input);
  const seatedTables = new Set<string>();

  for (const booking of bookings) {
    const start = booking.start.getTime();
    const end = booking.end.getTime();
    for (const id of booking.tableIds) add(id, { start, end, kind: 'booking' });
    if (booking.status === 'seated') {
      for (const id of booking.tableIds) {
        seatedTables.add(id);
        // Overrun: a seated party keeps its table until it is finished.
        if (end <= now.getTime()) add(id, { start: end, end: rolling, kind: 'occupied' });
      }
    }
  }

  const seatsOf = new Map(tables.map((t) => [t.id, t.seats]));
  for (const order of openOrders) {
    if (seatedTables.has(order.tableId)) continue; // counted once, by the booking
    const size = order.covers ?? seatsOf.get(order.tableId) ?? 1;
    const turnEnd = order.openedAt.getTime() + turnTimeFor(size, settings.turnTimes) * MINUTE;
    add(order.tableId, { start: now.getTime(), end: Math.max(turnEnd, rolling), kind: 'occupied' });
  }
  return busy;
}

function isFree(tableIds: readonly string[], booking: Interval, busy: Map<string, Busy[]>) {
  return conflicts(tableIds, booking, busy).length === 0;
}

function conflicts(tableIds: readonly string[], booking: Interval, busy: Map<string, Busy[]>) {
  return tableIds.flatMap((id) =>
    (busy.get(id) ?? []).filter((b) => b.end > booking.start && b.start < booking.end),
  );
}

/** Pacing for the slot that `start` falls in (the grid on the local wall clock). */
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
  busy: Map<string, Busy[]>,
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

// --- One booking at an exact time (R1.6 write-time checks) ----------------------------------------

export interface BookingRequest {
  start: Date;
  end: Date;
  /** The tables asked for; omitted = the engine's choice (smallest single, then a combination). */
  tableIds?: readonly string[];
  /** A walk-in may take `walk_in_only` tables. */
  walkIn?: boolean;
}

export type BookingProblem =
  | 'table_not_found'
  | 'table_walk_in_only'
  | 'party_size_out_of_range'
  | 'table_occupied'
  | 'table_unavailable';

/** Rules staff may override with `force` (docs/modules/reservations.md → R1.6, Q2). */
export type RuleBreach = 'pacing' | 'serviceHours';

export type BookingVerdict =
  /** `nextStartsAt`: a later booking is in the way; the party could stay until then (walk-ins). */
  | { ok: false; problem: BookingProblem; nextStartsAt?: string }
  | { ok: true; tableIds: string[]; combinationId?: string; breaches: RuleBreach[] };

/**
 * Whether `request` can be booked for `input.partySize` (`input.bookings` without the booking being
 * moved). Problems are refusals; breaches are rules `force` may override. The exclusion constraint
 * stays the last word against races.
 */
export function evaluateBooking(input: AvailabilityInput, request: BookingRequest): BookingVerdict {
  const booking: Interval = { start: request.start.getTime(), end: request.end.getTime() };
  const busy = busyIntervals(input);
  let chosen: { tableIds: string[]; combinationId?: string };

  if (request.tableIds) {
    const problem = checkChosen(input, request.tableIds, request.walkIn === true);
    if (problem) return { ok: false, problem };
    const hit = conflicts(request.tableIds, booking, busy);
    if (hit.some((b) => b.kind === 'occupied')) return { ok: false, problem: 'table_occupied' };
    if (hit.length > 0) {
      const running = hit.some((b) => b.start <= booking.start);
      const next = Math.min(...hit.map((b) => b.start));
      return running
        ? { ok: false, problem: 'table_unavailable' }
        : { ok: false, problem: 'table_unavailable', nextStartsAt: new Date(next).toISOString() };
    }
    chosen = { tableIds: [...request.tableIds] };
  } else {
    const singles = candidateTables(input);
    const combinations = candidateCombinations(input);
    if (singles.length === 0 && combinations.length === 0) {
      return { ok: false, problem: 'party_size_out_of_range' };
    }
    const allocation = allocate(booking, busy, singles, combinations);
    if (!allocation) return { ok: false, problem: 'table_unavailable' };
    chosen =
      allocation.kind === 'table'
        ? { tableIds: [allocation.tableId] }
        : { tableIds: allocation.tableIds, combinationId: allocation.combinationId };
  }

  const breaches: RuleBreach[] = [];
  if (pacingExceeded(input, gridStart(input, booking.start))) breaches.push('pacing');
  if (!withinServiceHours(input, booking.start)) breaches.push('serviceHours');
  return { ok: true, ...chosen, breaches };
}

/** Chosen tables: known and in service, bookable here, and big enough together. */
function checkChosen(
  input: AvailabilityInput,
  tableIds: readonly string[],
  walkIn: boolean,
): BookingProblem | null {
  const byId = new Map(input.tables.map((t) => [t.id, t]));
  const tables = tableIds.map((id) => byId.get(id));
  if (tables.some((t) => t === undefined)) return 'table_not_found';
  const known = tables as EngineTable[];
  if (!walkIn && known.some((t) => t.bookingMode === 'walk_in_only')) return 'table_walk_in_only';
  if (input.channel === 'online' && known.some((t) => !bookable(t, 'online'))) {
    return 'table_not_found';
  }
  const party = input.partySize;
  if (known.length === 1) {
    const [t] = known;
    return t!.minParty <= party && party <= capacity(t!) ? null : 'party_size_out_of_range';
  }
  // Exactly a defined combination: its own range. Any other set: the capacities add up.
  const key = [...tableIds].sort().join();
  const combination = input.combinations.find((c) => [...c.tableIds].sort().join() === key);
  if (combination) {
    return combination.minParty <= party && party <= combination.maxParty
      ? null
      : 'party_size_out_of_range';
  }
  const total = known.reduce((sum, t) => sum + capacity(t), 0);
  return party <= total ? null : 'party_size_out_of_range';
}

/** The start of the slot `start` falls in, on the local wall clock grid. */
function gridStart(input: AvailabilityInput, start: number): number {
  const { timeZone, settings } = input;
  const local = zonedParts(new Date(start), timeZone);
  const minute = local.hour * 60 + local.minute;
  const floored = minute - (minute % settings.slotIntervalMinutes);
  return zonedInstant(local.date, clock(floored), timeZone)?.getTime() ?? start;
}

/** Whether `start` lies in a reservation window (its own date's, or the day before's past midnight). */
function withinServiceHours(input: AvailabilityInput, start: number): boolean {
  const { timeZone, settings } = input;
  const date = zonedParts(new Date(start), timeZone).date;
  return [addDays(date, -1), date].some((day) =>
    serviceWindows({ ...input, date: day }).some(
      (w) => start >= w.start && start <= w.end - settings.lastBookingOffsetMinutes * MINUTE,
    ),
  );
}
