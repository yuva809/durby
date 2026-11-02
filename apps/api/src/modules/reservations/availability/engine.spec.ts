import { DEFAULT_TURN_TIMES, type WeeklyHours, zonedInstant } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  availability,
  type AvailabilityInput,
  evaluateBooking,
  type EngineBooking,
  type EngineCombination,
  type EngineTable,
} from './engine';

/** docs/modules/reservations.md → Availability engine: the pure core, no database, no clock. */

const BERLIN = 'Europe/Berlin';
const SAT = '2026-11-14'; // a Saturday, CET (+01:00)

const at = (date: string, time: string) => zonedInstant(date, time, BERLIN)!;
const hhmm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: BERLIN,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));

const EVENING = [{ from: '17:00', to: '23:00' }];
const every = (windows: WeeklyHours['mon']): WeeklyHours => ({
  mon: windows,
  tue: windows,
  wed: windows,
  thu: windows,
  fri: windows,
  sat: windows,
  sun: windows,
});

const table = (id: string, seats: number, extra: Partial<EngineTable> = {}): EngineTable => ({
  id,
  name: id,
  seats,
  sortOrder: 0,
  bookingMode: 'all',
  minParty: 1,
  maxParty: null,
  ...extra,
});

const T2A = table('T2a', 2);
const T2B = table('T2b', 2);
const T4 = table('T4', 4);
const T6 = table('T6', 6);
const WALK = table('W4', 4, { bookingMode: 'walk_in_only' });

const combination = (id: string, tableIds: string[], minParty: number, maxParty: number) =>
  ({
    id,
    name: id,
    tableIds,
    minParty,
    maxParty,
    onlineBookable: true,
  }) satisfies EngineCombination;

function input(over: Partial<AvailabilityInput> = {}): AvailabilityInput {
  const { settings, ...rest } = over;
  return {
    date: SAT,
    timeZone: BERLIN,
    now: at('2026-11-14', '09:00'),
    channel: 'staff',
    partySize: 2,
    tables: [T2A, T2B, T4, T6],
    combinations: [],
    bookings: [],
    openOrders: [],
    ...rest,
    settings: {
      openingHours: every(EVENING),
      closedDates: [],
      serviceHours: 'openingHours',
      slotIntervalMinutes: 15,
      turnTimes: DEFAULT_TURN_TIMES,
      maxCoversPerSlot: 'off',
      lastBookingOffsetMinutes: 60,
      instantMaxParty: 10,
      ...settings,
    },
  };
}

const booking = (
  tableIds: string[],
  from: string,
  to: string,
  extra: Partial<EngineBooking> = {},
): EngineBooking => ({
  id: `b-${tableIds.join('+')}-${from}`,
  status: 'booked',
  partySize: 2,
  start: at(SAT, from),
  end: at(SAT, to),
  tableIds,
  ...extra,
});

const slotAt = (result: ReturnType<typeof availability>, time: string) =>
  result.slots.find((s) => hhmm(s.start) === time);

const tableOf = (slot: ReturnType<typeof slotAt>) =>
  slot?.allocation?.kind === 'table'
    ? slot.allocation.tableId
    : slot?.allocation?.kind === 'combination'
      ? slot.allocation.combinationId
      : null;

describe('slots', () => {
  it('runs every interval from opening to the last booking before closing', () => {
    const result = availability(input());
    expect(result.closed).toBe(false);
    expect(result.turnMinutes).toBe(90);
    const times = result.slots.map((s) => hhmm(s.start));
    expect(times[0]).toBe('17:00');
    expect(times.at(-1)).toBe('22:00'); // 23:00 close − 60 min
    expect(times).toHaveLength(21);
    expect(result.slots[0]).toMatchObject({
      start: '2026-11-14T16:00:00.000Z',
      end: '2026-11-14T17:30:00.000Z',
      status: 'available',
    });
  });

  it('has no slots on a closed date', () => {
    const result = availability(input({ settings: { closedDates: [SAT] } as never }));
    expect(result).toMatchObject({ closed: true, slots: [] });
  });

  it('narrows the opening hours to the reservation hours, never widens them', () => {
    const narrow = availability(
      input({
        settings: {
          openingHours: every([{ from: '11:00', to: '23:00' }]),
          serviceHours: every([{ from: '18:00', to: '22:00' }]),
        } as never,
      }),
    );
    expect(narrow.slots.map((s) => hhmm(s.start))).toEqual(
      [
        '18:00',
        '18:15',
        '18:30',
        '18:45',
        '19:00',
        '19:15',
        '19:30',
        '19:45',
        '20:00',
        '20:15',
      ].concat(['20:30', '20:45', '21:00']),
    );
    const wider = availability(
      input({ settings: { serviceHours: every([{ from: '12:00', to: '23:30' }]) } as never }),
    );
    expect(hhmm(wider.slots[0]!.start)).toBe('17:00');
    expect(hhmm(wider.slots.at(-1)!.start)).toBe('22:00');
  });

  it('leaves out slots that have started', () => {
    const result = availability(input({ now: at(SAT, '18:10') }));
    expect(hhmm(result.slots[0]!.start)).toBe('18:15');
  });

  it('uses the turn time of the party size', () => {
    expect(availability(input({ partySize: 3 })).turnMinutes).toBe(120);
    expect(availability(input({ partySize: 6 })).turnMinutes).toBe(150);
  });

  it('honours 30 and 60 minute intervals', () => {
    const half = availability(input({ settings: { slotIntervalMinutes: 30 } as never }));
    expect(half.slots.map((s) => hhmm(s.start)).slice(0, 3)).toEqual(['17:00', '17:30', '18:00']);
    const hour = availability(input({ settings: { slotIntervalMinutes: 60 } as never }));
    expect(hour.slots.map((s) => hhmm(s.start))).toEqual([
      '17:00',
      '18:00',
      '19:00',
      '20:00',
      '21:00',
      '22:00',
    ]);
  });
});

describe('DST', () => {
  const night = every([{ from: '22:00', to: '04:00' }]);

  it('skips the wall times that spring forward removes (Sat 28 March 2026)', () => {
    const result = availability(
      input({
        date: '2026-03-28',
        now: at('2026-03-28', '09:00'),
        settings: { openingHours: night } as never,
      }),
    );
    const times = result.slots.map((s) => hhmm(s.start));
    expect(times).not.toContain('02:00');
    expect(times).not.toContain('02:45');
    expect(times.slice(-3)).toEqual(['01:30', '01:45', '03:00']); // last start 04:00 − 60 = 03:00
    expect(result.slots.at(-1)!.start).toBe('2026-03-29T01:00:00.000Z');
    expect(new Set(result.slots.map((s) => s.start)).size).toBe(result.slots.length);
  });

  it('offers a repeated autumn wall time once, at the earlier instant (Sat 24 October 2026)', () => {
    const result = availability(
      input({
        date: '2026-10-24',
        now: at('2026-10-24', '09:00'),
        settings: { openingHours: night } as never,
      }),
    );
    const twoThirty = result.slots.filter((s) => hhmm(s.start) === '02:30');
    expect(twoThirty.map((s) => s.start)).toEqual(['2026-10-25T00:30:00.000Z']); // CEST, the first one
    expect(hhmm(result.slots.at(-1)!.start)).toBe('03:00');
    expect(result.slots.at(-1)!.start).toBe('2026-10-25T02:00:00.000Z'); // 04:00 CET − 60 min
  });

  it('keeps the evening slots in local time across the switch and moves them by an hour in UTC', () => {
    const before = availability(input({ date: '2026-03-28', now: at('2026-03-28', '09:00') }));
    const after = availability(input({ date: '2026-03-29', now: at('2026-03-29', '09:00') }));
    expect(before.slots.map((s) => hhmm(s.start))).toEqual(after.slots.map((s) => hhmm(s.start)));
    expect(before.slots[0]!.start).toBe('2026-03-28T16:00:00.000Z');
    expect(after.slots[0]!.start).toBe('2026-03-29T15:00:00.000Z');
  });
});

describe('table choice', () => {
  it('gives the smallest table that fits: 2 guests a 2-top, 3 guests the 4-top', () => {
    expect(tableOf(slotAt(availability(input()), '19:00'))).toBe('T2a');
    expect(tableOf(slotAt(availability(input({ partySize: 3 })), '19:00'))).toBe('T4');
    expect(tableOf(slotAt(availability(input({ partySize: 5 })), '19:00'))).toBe('T6');
  });

  it('moves up one size only when the smaller tables are taken, never straight to the 6-top', () => {
    const result = availability(
      input({
        bookings: [booking(['T2a'], '18:30', '20:30'), booking(['T2b'], '18:30', '20:30')],
      }),
    );
    expect(tableOf(slotAt(result, '19:00'))).toBe('T4');
  });

  it('lets turns touch: a table freed at 19:30 is offered at 19:30', () => {
    const result = availability(input({ bookings: [booking(['T2a'], '18:00', '19:30')] }));
    expect(tableOf(slotAt(result, '18:00'))).toBe('T2b');
    expect(tableOf(slotAt(result, '19:30'))).toBe('T2a');
  });

  it('uses a combination only when no single table fits', () => {
    const combos = [
      combination('T4+T6', ['T4', 'T6'], 7, 10),
      combination('T2a+T2b', ['T2a', 'T2b'], 3, 4),
    ];
    // 4 guests: the 4-top, although a 2+2 combination would fit too.
    expect(
      tableOf(slotAt(availability(input({ partySize: 4, combinations: combos })), '19:00')),
    ).toBe('T4');
    // 8 guests: no single table fits.
    expect(
      tableOf(slotAt(availability(input({ partySize: 8, combinations: combos })), '19:00')),
    ).toBe('T4+T6');
    // ...and none at all when one member is taken.
    const taken = availability(
      input({ partySize: 8, combinations: combos, bookings: [booking(['T6'], '18:30', '21:00')] }),
    );
    expect(slotAt(taken, '19:00')).toMatchObject({ status: 'full', reason: 'no_table' });
  });

  it('falls back to a combination when the fitting single tables are taken', () => {
    const combos = [combination('T2a+T2b', ['T2a', 'T2b'], 3, 4)];
    const result = availability(
      input({
        partySize: 4,
        combinations: combos,
        bookings: [booking(['T4'], '18:30', '21:00'), booking(['T6'], '18:30', '21:00')],
      }),
    );
    expect(tableOf(slotAt(result, '19:00'))).toBe('T2a+T2b');
  });

  it('respects a table rule party range', () => {
    const picky = [T2A, table('T4', 4, { minParty: 3 }), T6];
    // 2 guests and the 2-top taken: the 4-top refuses parties under 3, so the 6-top.
    const result = availability(
      input({ tables: picky, bookings: [booking(['T2a'], '18:30', '20:30')] }),
    );
    expect(tableOf(slotAt(result, '19:00'))).toBe('T6');
  });

  it("keeps 2 guests off a 6-top whose rule says min party 4, even when it's the only free table", () => {
    const sixMin4 = table('T6', 6, { minParty: 4 });
    const result = availability(
      input({
        tables: [T2A, T2B, sixMin4],
        bookings: [booking(['T2a'], '19:00', '21:00'), booking(['T2b'], '19:00', '21:00')],
      }),
    );
    expect(slotAt(result, '19:30')).toMatchObject({ status: 'full', reason: 'no_table' });
    // 4 guests may have it.
    const four = availability(input({ partySize: 4, tables: [T2A, T2B, sixMin4] }));
    expect(tableOf(slotAt(four, '19:30'))).toBe('T6');
  });

  it('never books a walk-in-only table, nor a combination containing one', () => {
    const tables = [T4, WALK];
    const combos = [combination('T4+W4', ['T4', 'W4'], 5, 8)];
    const free = availability(input({ partySize: 4, tables, combinations: combos }));
    expect(tableOf(slotAt(free, '19:00'))).toBe('T4');
    const t4Taken = availability(
      input({
        partySize: 4,
        tables,
        combinations: combos,
        bookings: [booking(['T4'], '18:30', '21:00')],
      }),
    );
    expect(slotAt(t4Taken, '19:00')).toMatchObject({ status: 'full', reason: 'no_table' });
    const big = availability(input({ partySize: 6, tables, combinations: combos }));
    expect(slotAt(big, '19:00')).toMatchObject({ status: 'full', reason: 'no_table' });
  });

  it('keeps staff-only tables and offline combinations from the online widget', () => {
    const tables = [table('T2s', 2, { bookingMode: 'staff_only' }), T4];
    expect(tableOf(slotAt(availability(input({ tables })), '19:00'))).toBe('T2s');
    expect(tableOf(slotAt(availability(input({ tables, channel: 'online' })), '19:00'))).toBe('T4');
    const combos = [{ ...combination('T4+T6', ['T4', 'T6'], 7, 10), onlineBookable: false }];
    const online = availability(input({ partySize: 8, combinations: combos, channel: 'online' }));
    expect(slotAt(online, '19:00')).toMatchObject({ status: 'full', reason: 'no_table' });
  });
});

describe('occupancy', () => {
  // Only the 4-top fits 4 guests here, so its occupancy decides.
  const only4 = { partySize: 4, tables: [T4] };

  it('keeps an overrunning seated party on its table in a rolling window (21:05: 21:15 full, 21:30 free)', () => {
    const seated = booking(['T4'], '19:00', '21:00', { status: 'seated', partySize: 4 });
    const at2105 = availability(input({ ...only4, bookings: [seated], now: at(SAT, '21:05') }));
    expect(slotAt(at2105, '21:00')).toBeUndefined(); // started
    expect(slotAt(at2105, '21:15')).toMatchObject({ status: 'full', reason: 'no_table' });
    expect(slotAt(at2105, '21:30')).toMatchObject({ status: 'available' });
    const at2116 = availability(input({ ...only4, bookings: [seated], now: at(SAT, '21:16') }));
    expect(slotAt(at2116, '21:30')).toMatchObject({ status: 'full' });
    expect(slotAt(at2116, '21:45')).toMatchObject({ status: 'available' });
  });

  it('frees the table at the planned end while the party is not yet overrunning', () => {
    const seated = booking(['T4'], '19:00', '21:00', { status: 'seated', partySize: 4 });
    const result = availability(input({ ...only4, bookings: [seated], now: at(SAT, '20:55') }));
    expect(slotAt(result, '21:00')).toMatchObject({ status: 'available' });
  });

  it('holds a table with an open pos order from now until its turn ends, rolling while it stays open', () => {
    const order = { tableId: 'T4', openedAt: at(SAT, '20:00'), covers: 4 }; // 4 guests: 120 min → 22:00
    const result = availability(input({ ...only4, openOrders: [order], now: at(SAT, '20:30') }));
    expect(slotAt(result, '20:45')).toMatchObject({ status: 'full' });
    expect(slotAt(result, '21:45')).toMatchObject({ status: 'full' });
    expect(slotAt(result, '22:00')).toMatchObject({ status: 'available' });
    // Still open at 22:05: blocked until the next slot after now.
    const late = availability(input({ ...only4, openOrders: [order], now: at(SAT, '22:05') }));
    expect(late.slots).toEqual([]); // last booking 22:00 has started
    const lateOpen = availability(
      input({
        ...only4,
        openOrders: [order],
        now: at(SAT, '22:05'),
        settings: { lastBookingOffsetMinutes: 30 } as never,
      }),
    );
    expect(slotAt(lateOpen, '22:15')).toMatchObject({ status: 'full' });
    expect(slotAt(lateOpen, '22:30')).toMatchObject({ status: 'available' });
  });

  it('counts a table with a seated booking and an open order once (the booking)', () => {
    const seated = booking(['T4'], '19:00', '21:00', { status: 'seated', partySize: 4 });
    const order = { tableId: 'T4', openedAt: at(SAT, '19:05'), covers: 4 };
    const both = availability(
      input({ ...only4, bookings: [seated], openOrders: [order], now: at(SAT, '20:00') }),
    );
    const bookingOnly = availability(
      input({ ...only4, bookings: [seated], now: at(SAT, '20:00') }),
    );
    expect(both.slots).toEqual(bookingOnly.slots);
    expect(slotAt(both, '21:00')).toMatchObject({ status: 'available' });
  });

  it('ignores open orders and overruns for another day', () => {
    const order = { tableId: 'T4', openedAt: at(SAT, '20:00'), covers: 4 };
    const result = availability(
      input({ ...only4, date: '2026-11-15', openOrders: [order], now: at(SAT, '20:30') }),
    );
    expect(result.slots.every((s) => s.status === 'available')).toBe(true);
  });
});

describe('pacing and the instant-booking threshold', () => {
  it('fills a slot when its covers would pass maxCoversPerSlot', () => {
    const settings = { maxCoversPerSlot: 6 } as never;
    const bookings = [booking(['T4'], '19:00', '21:00', { partySize: 4 })];
    expect(slotAt(availability(input({ settings, bookings })), '19:00')).toMatchObject({
      status: 'available',
    }); // 4 + 2 = 6
    expect(
      slotAt(availability(input({ settings, bookings, partySize: 3 })), '19:00'),
    ).toMatchObject({
      status: 'full',
      reason: 'pacing',
    }); // 4 + 3 = 7
    expect(
      slotAt(availability(input({ settings, bookings, partySize: 3 })), '19:15'),
    ).toMatchObject({
      status: 'available',
    }); // another slot
  });

  it('turns online parties above instantMaxParty into requests, never removing a slot capacity allows', () => {
    const combos = [combination('T4+T6', ['T4', 'T6'], 7, 12)];
    const online = availability(input({ partySize: 12, combinations: combos, channel: 'online' }));
    expect(slotAt(online, '19:00')).toMatchObject({
      status: 'request',
      allocation: { kind: 'combination', combinationId: 'T4+T6' },
    });
    // Staff book it directly.
    expect(
      slotAt(availability(input({ partySize: 12, combinations: combos })), '19:00'),
    ).toMatchObject({ status: 'available' });
    // 'off': every size books instantly.
    const off = availability(
      input({
        partySize: 12,
        combinations: combos,
        channel: 'online',
        settings: { instantMaxParty: 'off' } as never,
      }),
    );
    expect(slotAt(off, '19:00')).toMatchObject({ status: 'available' });
    // Capacity still decides: no fitting table, no request.
    const tooBig = availability(input({ partySize: 14, combinations: combos, channel: 'online' }));
    expect(tooBig.slots.every((s) => s.status === 'full' && s.reason === 'no_table')).toBe(true);
  });
});

describe('evaluateBooking: one booking at an exact time (R1.6 write-time checks)', () => {
  const req = (
    from: string,
    to: string,
    extra: { tableIds?: string[]; walkIn?: boolean } = {},
  ) => ({
    start: at(SAT, from),
    end: at(SAT, to),
    ...extra,
  });

  it('picks the smallest free table at any minute, like the slot grid', () => {
    expect(evaluateBooking(input(), req('19:10', '20:40'))).toEqual({
      ok: true,
      tableIds: ['T2a'],
      breaches: [],
    });
    expect(
      evaluateBooking(
        input({ bookings: [booking(['T2a'], '19:00', '20:30')] }),
        req('19:10', '20:40'),
      ),
    ).toMatchObject({ ok: true, tableIds: ['T2b'] });
  });

  it('falls back to a combination, and says why when nothing is left', () => {
    const big = input({
      partySize: 8,
      combinations: [combination('C46', ['T4', 'T6'], 7, 10)],
    });
    expect(evaluateBooking(big, req('19:00', '21:30'))).toEqual({
      ok: true,
      tableIds: ['T4', 'T6'],
      combinationId: 'C46',
      breaches: [],
    });
    expect(
      evaluateBooking(
        { ...big, bookings: [booking(['T6'], '20:00', '22:00')] },
        req('19:00', '21:30'),
      ),
    ).toEqual({ ok: false, problem: 'table_unavailable' });
    expect(evaluateBooking(input({ partySize: 12 }), req('19:00', '21:30'))).toEqual({
      ok: false,
      problem: 'party_size_out_of_range',
    });
  });

  it('checks chosen tables: known, bookable, big enough', () => {
    const ins = input({ tables: [T2A, T4, T6, WALK] });
    expect(evaluateBooking(ins, req('19:00', '20:30', { tableIds: ['nope'] }))).toEqual({
      ok: false,
      problem: 'table_not_found',
    });
    expect(evaluateBooking(ins, req('19:00', '20:30', { tableIds: ['W4'] }))).toEqual({
      ok: false,
      problem: 'table_walk_in_only',
    });
    expect(
      evaluateBooking(ins, req('19:00', '20:30', { tableIds: ['W4'], walkIn: true })),
    ).toMatchObject({ ok: true, tableIds: ['W4'] });
    expect(
      evaluateBooking({ ...ins, partySize: 5 }, req('19:00', '20:30', { tableIds: ['T4'] })),
    ).toEqual({ ok: false, problem: 'party_size_out_of_range' });
    // Several tables that aren't a combination: their capacities add up.
    expect(
      evaluateBooking({ ...ins, partySize: 6 }, req('19:00', '20:30', { tableIds: ['T2a', 'T4'] })),
    ).toMatchObject({ ok: true, tableIds: ['T2a', 'T4'] });
    expect(
      evaluateBooking({ ...ins, partySize: 7 }, req('19:00', '20:30', { tableIds: ['T2a', 'T4'] })),
    ).toEqual({ ok: false, problem: 'party_size_out_of_range' });
  });

  it("applies a defined combination's own range to exactly its tables", () => {
    const ins = input({ partySize: 4, combinations: [combination('C46', ['T4', 'T6'], 7, 10)] });
    expect(evaluateBooking(ins, req('19:00', '21:00', { tableIds: ['T6', 'T4'] }))).toEqual({
      ok: false,
      problem: 'party_size_out_of_range',
    });
  });

  it('tells occupied tables (open order, overrunning party) from booked ones', () => {
    const now = at(SAT, '19:05');
    const order = input({
      now,
      openOrders: [{ tableId: 'T4', openedAt: at(SAT, '18:30'), covers: 4 }],
    });
    expect(evaluateBooking(order, req('19:30', '21:00', { tableIds: ['T4'] }))).toEqual({
      ok: false,
      problem: 'table_occupied',
    });
    const overrun = input({
      now: at(SAT, '21:05'),
      bookings: [booking(['T4'], '19:00', '21:00', { status: 'seated' })],
    });
    expect(evaluateBooking(overrun, req('21:00', '22:30', { tableIds: ['T4'] }))).toEqual({
      ok: false,
      problem: 'table_occupied',
    });
    const booked = input({ bookings: [booking(['T4'], '19:00', '21:00')] });
    expect(evaluateBooking(booked, req('20:00', '21:30', { tableIds: ['T4'] }))).toEqual({
      ok: false,
      problem: 'table_unavailable',
    });
  });

  it('reports pacing and reservation hours as breaches, not refusals', () => {
    const paced = input({
      settings: { maxCoversPerSlot: 4 } as never,
      bookings: [booking(['T4'], '19:00', '21:00', { partySize: 4 })],
    });
    // 19:10 counts in the 19:00–19:15 slot.
    expect(evaluateBooking(paced, req('19:10', '20:40'))).toMatchObject({
      ok: true,
      breaches: ['pacing'],
    });
    // Opening 17:00–23:00, last booking 22:00.
    expect(evaluateBooking(input(), req('22:10', '23:40'))).toMatchObject({
      ok: true,
      breaches: ['serviceHours'],
    });
    expect(evaluateBooking(input(), req('16:00', '17:30'))).toMatchObject({
      ok: true,
      breaches: ['serviceHours'],
    });
    expect(
      evaluateBooking(input({ settings: { closedDates: [SAT] } as never }), req('19:00', '20:30')),
    ).toMatchObject({ ok: true, breaches: ['serviceHours'] });
  });

  it('counts a window past midnight for the day it starts', () => {
    const late = input({
      settings: { openingHours: every([{ from: '18:00', to: '02:00' }]) } as never,
    });
    // Sunday 00:30 belongs to Saturday's window (last booking 01:00).
    expect(
      evaluateBooking(late, { start: at('2026-11-15', '00:30'), end: at('2026-11-15', '02:00') }),
    ).toMatchObject({
      ok: true,
      breaches: [],
    });
  });
});
