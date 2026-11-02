import { DEFAULT_TURN_TIMES, zonedInstant } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { deriveFloor, type FloorBooking, type FloorInput, type TableFloorState } from './derive';

/** docs/modules/reservations.md → Derived floor state: the pure core, no database, no clock. */

const BERLIN = 'Europe/Berlin';
const SAT = '2026-11-14'; // a Saturday, CET (+01:00)
const SUN = '2026-11-15';

const at = (date: string, time: string) => zonedInstant(date, time, BERLIN)!;

const table = (
  id: string,
  seats = 4,
  bookingMode: 'all' | 'staff_only' | 'walk_in_only' = 'all',
) => ({
  id,
  seats,
  bookingMode,
});

const booking = (
  id: string,
  status: FloorBooking['status'],
  from: string,
  to: string,
  tableIds: string[] = ['T4'],
  extra: Partial<FloorBooking> = {},
): FloorBooking => ({
  id,
  status,
  partySize: 4,
  start: at(SAT, from),
  end: at(SAT, to),
  seatedAt: status === 'seated' ? at(SAT, from) : null,
  tableIds,
  guestName: `Guest ${id}`,
  ...extra,
});

function input(over: Partial<FloorInput> = {}): FloorInput {
  const now = over.now ?? at(SAT, '19:00');
  return {
    at: now,
    now,
    live: true,
    timeZone: BERLIN,
    slotIntervalMinutes: 15,
    horizonMinutes: 60,
    turnTimes: DEFAULT_TURN_TIMES,
    tables: [table('T4')],
    bookings: [],
    openOrders: [],
    ...over,
  };
}

const stateOf = (floor: TableFloorState[], id = 'T4') => floor.find((t) => t.tableId === id)!;

describe('states', () => {
  it('is free without bookings or orders, with no current and no next', () => {
    expect(stateOf(deriveFloor(input()))).toEqual({
      tableId: 'T4',
      state: 'free',
      overrun: false,
      walkInOnly: false,
      current: null,
      next: null,
    });
  });

  it('is occupied while a seated booking holds the table, with the party as current', () => {
    const seated = booking('S', 'seated', '18:30', '20:30', ['T4'], { seatedAt: at(SAT, '18:41') });
    const t = stateOf(deriveFloor(input({ bookings: [seated] })));
    expect(t.state).toBe('occupied');
    expect(t.overrun).toBe(false);
    expect(t.current).toEqual({
      reservationId: 'S',
      partySize: 4,
      guestName: 'Guest S',
      since: at(SAT, '18:41'),
      until: at(SAT, '20:30'),
    });
  });

  it('is occupied by an open pos order without a booking (covers as party size)', () => {
    const order = { tableId: 'T4', openedAt: at(SAT, '18:20'), covers: 3 };
    const t = stateOf(deriveFloor(input({ openOrders: [order] })));
    expect(t.state).toBe('occupied');
    // 3 covers → 120 min turn: until 20:20.
    expect(t.current).toEqual({
      reservationId: null,
      partySize: 3,
      guestName: null,
      since: at(SAT, '18:20'),
      until: at(SAT, '20:20'),
    });
  });

  it('counts a seated booking with its open order once, as the booking', () => {
    const seated = booking('S', 'seated', '18:30', '20:30');
    const order = { tableId: 'T4', openedAt: at(SAT, '18:35'), covers: 5 };
    const t = stateOf(deriveFloor(input({ bookings: [seated], openOrders: [order] })));
    expect(t.state).toBe('occupied');
    expect(t.current?.reservationId).toBe('S');
    expect(t.current?.partySize).toBe(4);
  });

  it('is arriving while an arrived booking waits for the table', () => {
    const arrived = booking('A', 'arrived', '19:15', '21:15');
    const t = stateOf(deriveFloor(input({ bookings: [arrived] })));
    expect(t.state).toBe('arriving');
    expect(t.current?.reservationId).toBe('A');
    expect(t.next).toBeNull();
  });

  it('is reserved while a booked party is late (its period contains at)', () => {
    const late = booking('L', 'booked', '18:30', '20:30');
    const t = stateOf(deriveFloor(input({ bookings: [late] })));
    expect(t.state).toBe('reserved');
    expect(t.current?.reservationId).toBe('L');
  });

  it('is reserved_soon when the next booking starts within the horizon, inclusive', () => {
    const in60 = booking('N', 'booked', '20:00', '22:00');
    const t = stateOf(deriveFloor(input({ bookings: [in60] })));
    expect(t.state).toBe('reserved_soon');
    expect(t.current).toBeNull();
    expect(t.next).toEqual({
      reservationId: 'N',
      startsAt: at(SAT, '20:00'),
      partySize: 4,
      guestName: 'Guest N',
      tableStillOccupied: false,
    });
  });

  it('is free with a next booking beyond the horizon', () => {
    const in61 = booking('N', 'booked', '20:01', '22:00');
    const t = stateOf(deriveFloor(input({ bookings: [in61] })));
    expect(t.state).toBe('free');
    expect(t.next?.reservationId).toBe('N');
  });

  it('follows the horizon setting', () => {
    const in90 = booking('N', 'booked', '20:30', '22:00');
    const t = stateOf(deriveFloor(input({ bookings: [in90], horizonMinutes: 90 })));
    expect(t.state).toBe('reserved_soon');
  });

  it('treats a pending booking like a booked one', () => {
    const pending = booking('P', 'pending', '19:30', '21:00');
    expect(stateOf(deriveFloor(input({ bookings: [pending] }))).state).toBe('reserved_soon');
  });

  it('picks the earliest next booking and ignores ones that have ended', () => {
    const ended = booking('E', 'booked', '16:00', '18:00');
    const later = booking('B', 'booked', '21:30', '23:00');
    const sooner = booking('A', 'booked', '19:45', '21:30');
    const t = stateOf(deriveFloor(input({ bookings: [ended, later, sooner] })));
    expect(t.next?.reservationId).toBe('A');
  });

  it('prefers occupied over arriving, and shows the arrived party as next', () => {
    const seated = booking('S', 'seated', '17:30', '19:30');
    const arrived = booking('A', 'arrived', '19:30', '21:30');
    const t = stateOf(deriveFloor(input({ bookings: [seated, arrived] })));
    expect(t.state).toBe('occupied');
    expect(t.next?.reservationId).toBe('A');
    // The seated party leaves by its end: no conflict.
    expect(t.next?.tableStillOccupied).toBe(false);
  });

  it('marks walk_in_only tables with a badge whatever their state', () => {
    const floor = deriveFloor(input({ tables: [table('W', 4, 'walk_in_only')] }));
    expect(stateOf(floor, 'W')).toMatchObject({ state: 'free', walkInOnly: true });
  });

  it('applies a combination booking to each of its tables', () => {
    const tables = [table('T5'), table('T6'), table('T7')];
    const combo = booking('C', 'seated', '18:30', '20:30', ['T5', 'T6']);
    const floor = deriveFloor(input({ tables, bookings: [combo] }));
    expect(stateOf(floor, 'T5').state).toBe('occupied');
    expect(stateOf(floor, 'T6').state).toBe('occupied');
    expect(stateOf(floor, 'T7').state).toBe('free');
  });

  it('returns the tables in input order', () => {
    const tables = [table('B'), table('A'), table('C')];
    expect(deriveFloor(input({ tables })).map((t) => t.tableId)).toEqual(['B', 'A', 'C']);
  });
});

describe('overrun (live)', () => {
  const seated = booking('S', 'seated', '19:00', '21:00');
  const nine = booking('N', 'booked', '21:00', '23:00');

  it('keeps an overrunning party on its table and flags the booking already due (21:05)', () => {
    const now = at(SAT, '21:05');
    const t = stateOf(deriveFloor(input({ now, at: now, bookings: [seated, nine] })));
    expect(t.state).toBe('occupied');
    expect(t.overrun).toBe(true);
    expect(t.current?.reservationId).toBe('S');
    expect(t.next).toMatchObject({ reservationId: 'N', tableStillOccupied: true });
  });

  it('is not overrunning before the planned end (20:55)', () => {
    const now = at(SAT, '20:55');
    const t = stateOf(deriveFloor(input({ now, at: now, bookings: [seated, nine] })));
    expect(t).toMatchObject({ state: 'occupied', overrun: false });
    expect(t.next?.tableStillOccupied).toBe(false);
  });

  it('flags a later booking only while the rolling window reaches it', () => {
    const half = booking('H', 'booked', '21:30', '23:00');
    // 21:05 → occupied until 21:30 (21:15 + 15): 21:30 isn't reached.
    let now = at(SAT, '21:05');
    let t = stateOf(deriveFloor(input({ now, at: now, bookings: [seated, half] })));
    expect(t.next).toMatchObject({ reservationId: 'H', tableStillOccupied: false });
    // 21:16 → until 21:45: it is.
    now = at(SAT, '21:16');
    t = stateOf(deriveFloor(input({ now, at: now, bookings: [seated, half] })));
    expect(t.next).toMatchObject({ reservationId: 'H', tableStillOccupied: true });
  });

  it('flags the next booking when a till order without a booking runs into it', () => {
    // Walk-in at the till at 18:30 with 4 covers (turn 120 → 20:30); the next booking is at 20:00.
    const order = { tableId: 'T4', openedAt: at(SAT, '18:30'), covers: 4 };
    const eight = booking('E', 'booked', '20:00', '22:00');
    const t = stateOf(deriveFloor(input({ openOrders: [order], bookings: [eight] })));
    expect(t.state).toBe('occupied');
    expect(t.next).toMatchObject({ reservationId: 'E', tableStillOccupied: true });
  });

  it('keeps an open order past its turn in the rolling window', () => {
    // Opened 17:00, 2 covers (90 min → 18:30); at 19:00 still open → until 19:00 + 15 = 19:15;
    // at 19:01 → 19:15 + 15 = 19:30.
    const order = { tableId: 'T4', openedAt: at(SAT, '17:00'), covers: 2 };
    let t = stateOf(deriveFloor(input({ openOrders: [order] })));
    expect(t.state).toBe('occupied');
    expect(t.current?.until).toEqual(at(SAT, '19:15'));
    const now = at(SAT, '19:01');
    t = stateOf(deriveFloor(input({ now, at: now, openOrders: [order] })));
    expect(t.current?.until).toEqual(at(SAT, '19:30'));
  });

  it('uses the table seats for an order without covers', () => {
    // 6 seats → 150 min turn: opened 18:00, until 20:30.
    const order = { tableId: 'T6', openedAt: at(SAT, '18:00'), covers: null };
    const t = stateOf(deriveFloor(input({ tables: [table('T6', 6)], openOrders: [order] })), 'T6');
    expect(t.current).toMatchObject({ partySize: null, until: at(SAT, '20:30') });
  });

  it('looks at a later time today with the occupancy known now', () => {
    // Now 19:00, looking at 21:00: the 18:00–20:00 party will be gone, the 21:00 booking is due.
    const now = at(SAT, '19:00');
    const early = booking('S', 'seated', '18:00', '20:00');
    const t = stateOf(deriveFloor(input({ now, at: at(SAT, '21:00'), bookings: [early, nine] })));
    expect(t.state).toBe('reserved');
    expect(t.current?.reservationId).toBe('N');
  });
});

describe('another day: bookings only', () => {
  const sunday = (id: string, status: FloorBooking['status'], from: string, to: string) =>
    booking(id, status, from, to, ['T4'], { start: at(SUN, from), end: at(SUN, to) });

  const planned = (over: Partial<FloorInput>) =>
    input({ now: at(SAT, '19:00'), at: at(SUN, '18:00'), live: false, ...over });

  it('ignores open orders', () => {
    const order = { tableId: 'T4', openedAt: at(SAT, '18:30'), covers: 4 };
    const t = stateOf(deriveFloor(planned({ openOrders: [order] })));
    expect(t.state).toBe('free');
    expect(t.current).toBeNull();
  });

  it('never marks an overrun or a table still occupied', () => {
    const stale = booking('S', 'seated', '12:00', '14:00');
    const next = sunday('N', 'booked', '18:30', '20:30');
    const t = stateOf(deriveFloor(planned({ bookings: [stale, next] })));
    expect(t.overrun).toBe(false);
    expect(t.state).toBe('reserved_soon');
    expect(t.next?.tableStillOccupied).toBe(false);
  });

  it('shows a booking whose period contains at as reserved', () => {
    const t = stateOf(
      deriveFloor(planned({ bookings: [sunday('B', 'booked', '17:30', '19:30')] })),
    );
    expect(t.state).toBe('reserved');
    expect(t.current).toMatchObject({ reservationId: 'B', until: at(SUN, '19:30') });
  });

  it('reads an arrived booking as reserved, not arriving', () => {
    const t = stateOf(
      deriveFloor(planned({ bookings: [sunday('A', 'arrived', '17:30', '19:30')] })),
    );
    expect(t.state).toBe('reserved');
  });

  it('shows a seated booking whose period contains at as occupied', () => {
    const t = stateOf(
      deriveFloor(planned({ bookings: [sunday('S', 'seated', '17:30', '19:30')] })),
    );
    expect(t.state).toBe('occupied');
  });

  it('is free between bookings beyond the horizon', () => {
    const t = stateOf(
      deriveFloor(
        planned({
          bookings: [
            sunday('A', 'booked', '12:00', '14:00'),
            sunday('B', 'booked', '20:00', '22:00'),
          ],
        }),
      ),
    );
    expect(t).toMatchObject({ state: 'free', next: { reservationId: 'B' } });
  });
});
