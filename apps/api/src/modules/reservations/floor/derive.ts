import { turnTimeFor, type TurnTimes } from '@durby/shared';
import { rollingEnd } from '../availability/engine';

/**
 * The host floor's state per table (docs/modules/reservations.md → Derived floor state). Pure: no
 * database and no clock (`now` and `at` are inputs), like the availability engine. FloorService
 * feeds it from one read transaction.
 */

export type FloorState = 'occupied' | 'arriving' | 'reserved' | 'reserved_soon' | 'free';

export interface FloorTableInput {
  id: string;
  seats: number;
  bookingMode: 'all' | 'staff_only' | 'walk_in_only';
}

/** A blocking booking on the floor (pending, booked, arrived, seated). */
export interface FloorBooking {
  id: string;
  status: 'pending' | 'booked' | 'arrived' | 'seated';
  partySize: number;
  start: Date;
  end: Date;
  seatedAt: Date | null;
  tableIds: readonly string[];
  guestName: string | null;
}

export interface FloorOpenOrder {
  tableId: string;
  openedAt: Date;
  covers: number | null;
}

export interface FloorInput {
  /** The moment shown. */
  at: Date;
  now: Date;
  /** `at` is today at the location: open orders, overrun and arriving count only then. */
  live: boolean;
  timeZone: string;
  slotIntervalMinutes: number;
  horizonMinutes: number;
  turnTimes: TurnTimes;
  /** In service, in floor order. */
  tables: readonly FloorTableInput[];
  bookings: readonly FloorBooking[];
  /** Ignored unless live. */
  openOrders: readonly FloorOpenOrder[];
}

export interface FloorCurrent {
  /** null for an open pos order without a booking. */
  reservationId: string | null;
  /** The booking's party, or the order's covers (null when not recorded). */
  partySize: number | null;
  guestName: string | null;
  since: Date;
  /** Planned end, or how long an open order is expected to hold the table. */
  until: Date | null;
}

export interface FloorNext {
  reservationId: string;
  startsAt: Date;
  partySize: number;
  guestName: string | null;
  /** Live: something else occupies the table past this booking's start (move it). */
  tableStillOccupied: boolean;
}

export interface TableFloorState {
  tableId: string;
  state: FloorState;
  overrun: boolean;
  walkInOnly: boolean;
  current: FloorCurrent | null;
  next: FloorNext | null;
}

const MINUTE = 60_000;

/** What occupies a table, over which interval. */
interface Occupant {
  current: FloorCurrent;
  start: number;
  end: number;
  overrun: boolean;
}

export function deriveFloor(input: FloorInput): TableFloorState[] {
  const at = input.at.getTime();
  const rolling = rollingEnd(input.now, input.timeZone, input.slotIntervalMinutes);
  const byTable = new Map<string, FloorBooking[]>();
  for (const booking of input.bookings) {
    for (const id of booking.tableIds) byTable.set(id, [...(byTable.get(id) ?? []), booking]);
  }
  const orderOf = new Map(input.live ? input.openOrders.map((o) => [o.tableId, o]) : []);

  return input.tables.map((table): TableFloorState => {
    const bookings = byTable.get(table.id) ?? [];
    const occupants = occupantsOf(input, table, bookings, orderOf.get(table.id), rolling);
    const occupant = occupants.find((o) => o.start <= at && at < o.end);
    const overrun = occupants.some((o) => o.overrun);

    let state: FloorState = 'free';
    let current: FloorCurrent | null = null;
    if (occupant) {
      state = 'occupied';
      current = occupant.current;
    } else {
      const arrived = input.live
        ? earliest(bookings.filter((b) => b.status === 'arrived' && b.end.getTime() > at))
        : undefined;
      const due = earliest(
        bookings.filter(
          (b) =>
            (b.status === 'pending' ||
              b.status === 'booked' ||
              (!input.live && b.status === 'arrived')) &&
            b.start.getTime() <= at &&
            at < b.end.getTime(),
        ),
      );
      if (arrived) {
        state = 'arriving';
        current = fromBooking(arrived);
      } else if (due) {
        state = 'reserved';
        current = fromBooking(due);
      }
    }

    // A booking due while the table is occupied counts too: that's the one to move.
    const upcoming = earliest(
      bookings.filter(
        (b) => b.id !== current?.reservationId && b.status !== 'seated' && b.end.getTime() > at,
      ),
    );
    const next: FloorNext | null = upcoming
      ? {
          reservationId: upcoming.id,
          startsAt: upcoming.start,
          partySize: upcoming.partySize,
          guestName: upcoming.guestName,
          tableStillOccupied:
            input.live && occupant !== undefined && occupant.end > upcoming.start.getTime(),
        }
      : null;
    if (state === 'free' && next && next.startsAt.getTime() - at <= input.horizonMinutes * MINUTE) {
      state = 'reserved_soon';
    }

    return {
      tableId: table.id,
      state,
      overrun,
      walkInOnly: table.bookingMode === 'walk_in_only',
      current,
      next,
    };
  });
}

/**
 * Seated bookings over their period (live: an overrunning one until the rolling end), then an open
 * order without a seated booking from its opening until max(turn end, rolling end).
 */
function occupantsOf(
  input: FloorInput,
  table: FloorTableInput,
  bookings: readonly FloorBooking[],
  order: FloorOpenOrder | undefined,
  rolling: number,
): Occupant[] {
  const now = input.now.getTime();
  const occupants: Occupant[] = [];
  for (const b of bookings) {
    if (b.status !== 'seated') continue;
    const overrun = input.live && b.end.getTime() <= now;
    occupants.push({
      current: fromBooking(b),
      start: b.start.getTime(),
      end: overrun ? rolling : b.end.getTime(),
      overrun,
    });
  }
  if (order && occupants.length === 0) {
    const size = order.covers ?? table.seats;
    const turnEnd = order.openedAt.getTime() + turnTimeFor(size, input.turnTimes) * MINUTE;
    const end = Math.max(turnEnd, rolling);
    occupants.push({
      current: {
        reservationId: null,
        partySize: order.covers,
        guestName: null,
        since: order.openedAt,
        until: new Date(end),
      },
      start: order.openedAt.getTime(),
      end,
      overrun: false,
    });
  }
  return occupants;
}

const fromBooking = (b: FloorBooking): FloorCurrent => ({
  reservationId: b.id,
  partySize: b.partySize,
  guestName: b.guestName,
  since: b.seatedAt ?? b.start,
  until: b.end,
});

/** Earliest start, then id: deterministic. */
function earliest(bookings: readonly FloorBooking[]): FloorBooking | undefined {
  return [...bookings].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id),
  )[0];
}
