import type { Reservation, ReservationsFloorTable } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  actionsFor,
  clockTime,
  dayCounts,
  instantAt,
  localDate,
  seatUntil,
  stillOccupied,
  tillBadge,
  timeOptions,
  undoable,
  undoMinutesLeft,
} from './host';

const BERLIN = 'Europe/Berlin';
const T = (hhmm: string, date = '2027-03-06') => `${date}T${hhmm}:00+01:00`;
const ms = (hhmm: string, date?: string) => Date.parse(T(hhmm, date));
const id = (n: number) => `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`;

function booking(over: Partial<Reservation> = {}): Reservation {
  return {
    id: id(1),
    number: 'RES-2027-000001',
    locationId: id(2),
    status: 'booked',
    source: 'staff',
    partySize: 2,
    startsAt: new Date(T('19:00')).toISOString(),
    endsAt: new Date(T('20:30')).toISOString(),
    tableIds: [id(3)],
    guest: { id: id(4), name: 'Weber', email: null, phone: null, locale: 'en' },
    guestNote: null,
    staffNote: null,
    createdAt: new Date(T('12:00')).toISOString(),
    lastChangeId: id(5),
    lastChange: {
      id: id(5),
      fromStatus: null,
      toStatus: 'booked',
      undoesId: null,
      actorKind: 'user',
      sourceOrderId: null,
      createdAt: new Date(T('12:00')).toISOString(),
    },
    tablesNotInService: [],
    ...over,
  };
}

const changed = (b: Reservation, over: Partial<Reservation['lastChange']>): Reservation => ({
  ...b,
  lastChange: { ...b.lastChange, ...over },
});

describe('actionsFor', () => {
  it('offers no-show only once the booking has started', () => {
    expect(actionsFor(booking(), ms('18:59'))).toEqual(['arrive', 'seat', 'cancel']);
    expect(actionsFor(booking(), ms('19:00'))).toEqual(['arrive', 'seat', 'no-show', 'cancel']);
    const arrived = booking({ status: 'arrived' });
    expect(actionsFor(arrived, ms('18:50'))).toEqual(['seat', 'cancel']);
    expect(actionsFor(arrived, ms('19:05'))).toEqual(['seat', 'no-show', 'cancel']);
  });

  it('finishes seated parties, cancels pending ones, and offers nothing once done', () => {
    expect(actionsFor(booking({ status: 'seated' }), ms('19:30'))).toEqual(['finish']);
    expect(actionsFor(booking({ status: 'pending' }), ms('19:30'))).toEqual(['cancel']);
    for (const status of ['finished', 'cancelled', 'no_show', 'requested'] as const) {
      expect(actionsFor(booking({ status }), ms('19:30'))).toEqual([]);
    }
  });
});

describe('undo', () => {
  const seated = changed(booking({ status: 'seated' }), {
    fromStatus: 'booked',
    toStatus: 'seated',
    createdAt: new Date(T('19:00')).toISOString(),
  });

  it('is offered for 5 minutes after a change that is neither the creation nor an undo', () => {
    expect(undoable(seated, ms('19:04') + 59_000)).toBe(true);
    expect(undoable(seated, ms('19:05') + 1_000)).toBe(false);
    expect(undoable(booking(), ms('12:01'))).toBe(false); // the creation
    expect(undoable(changed(seated, { undoesId: id(9) }), ms('19:01'))).toBe(false);
  });

  it('counts the minutes left, at least one', () => {
    expect(undoMinutesLeft(seated, ms('19:00') + 10_000)).toBe(5);
    expect(undoMinutesLeft(seated, ms('19:04') + 50_000)).toBe(1);
    // A browser clock behind the database's: never more than the window.
    expect(undoMinutesLeft(seated, ms('18:59') + 30_000)).toBe(5);
  });
});

describe('tillBadge', () => {
  it('marks bookings the till seated or finished, while they stay so', () => {
    const order = id(8);
    const auto = changed(booking({ status: 'seated' }), {
      actorKind: 'system',
      sourceOrderId: order,
      toStatus: 'seated',
    });
    expect(tillBadge(auto)).toBe('autoSeated');
    expect(
      tillBadge(
        changed(booking({ status: 'finished' }), {
          actorKind: 'system',
          sourceOrderId: order,
          toStatus: 'finished',
        }),
      ),
    ).toBe('finishedAtTill');
    expect(tillBadge(changed(booking({ status: 'seated' }), { toStatus: 'seated' }))).toBeNull();
    expect(tillBadge(changed(auto, { sourceOrderId: null }))).toBeNull();
  });
});

describe('dayCounts', () => {
  it('counts covers of blocking bookings, booked and seated', () => {
    const list = [
      booking({ partySize: 2 }),
      booking({ status: 'pending', partySize: 3 }),
      booking({ status: 'arrived', partySize: 4 }),
      booking({ status: 'seated', partySize: 5 }),
      booking({ status: 'cancelled', partySize: 6 }),
      booking({ status: 'finished', partySize: 7 }),
    ];
    expect(dayCounts(list)).toEqual({ covers: 14, booked: 2, seated: 1 });
  });
});

const floorTable = (n: number, next: ReservationsFloorTable['next']): ReservationsFloorTable => ({
  id: id(20 + n),
  locationId: id(2),
  name: `T${n}`,
  seats: 4,
  areaId: null,
  area: null,
  shape: 'square',
  color: 'neutral',
  sortOrder: n,
  state: 'free',
  overrun: false,
  walkInOnly: false,
  current: null,
  next,
  occupied: false,
  occupiedSince: null,
  covers: null,
});
const next = (hhmm: string, still = false) => ({
  reservationId: id(30),
  startsAt: new Date(T(hhmm)).toISOString(),
  partySize: 2,
  guestName: 'Next',
  tableStillOccupied: still,
});

describe('floor helpers', () => {
  it('lists the bookings due on a table that is still occupied', () => {
    expect([...stillOccupied([floorTable(1, next('19:00', true)), floorTable(2, null)])]).toEqual([
      id(30),
    ]);
  });

  it('seats a walk-in until the earliest next booking of its tables, if 15 min or more away', () => {
    const tables = [
      floorTable(1, next('20:00')),
      floorTable(2, next('19:30')),
      floorTable(3, null),
    ];
    const now = ms('19:00');
    expect(seatUntil([id(21), id(22)], tables, now)).toBe(new Date(T('19:30')).toISOString());
    expect(seatUntil([id(23)], tables, now)).toBeNull();
    expect(seatUntil([id(22)], tables, ms('19:16'))).toBeNull(); // 14 minutes left
  });
});

describe('time at the location', () => {
  it('formats and builds local times in the location zone', () => {
    expect(clockTime(T('19:05'), BERLIN)).toBe('19:05');
    expect(clockTime('2027-03-06T18:05:00Z', 'Europe/London')).toBe('18:05');
    expect(localDate(ms('00:30', '2027-03-07'), BERLIN)).toBe('2027-03-07');
    expect(instantAt('2027-03-06', '19:30', BERLIN)).toBe(new Date(T('19:30')).toISOString());
    // Spring forward: 02:30 doesn't exist in Berlin on 2027-03-28.
    expect(instantAt('2027-03-28', '02:30', BERLIN)).toBeNull();
  });

  it('offers every 15 minutes through the service windows, in order', () => {
    const windows = [
      { start: new Date(T('18:00')).toISOString(), end: new Date(T('18:45')).toISOString() },
      { start: new Date(T('12:00')).toISOString(), end: new Date(T('12:30')).toISOString() },
    ];
    expect(timeOptions(windows, BERLIN).map((o) => o.label)).toEqual([
      '12:00',
      '12:15',
      '18:00',
      '18:15',
      '18:30',
    ]);
    expect(timeOptions([], BERLIN)).toEqual([]);
  });
});
