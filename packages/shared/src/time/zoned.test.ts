import { describe, expect, it } from 'vitest';
import {
  addDays,
  isLocalDate,
  isLocalTime,
  weekdayOf,
  zonedBound,
  zonedDayBounds,
  zonedInstant,
  zonedInstants,
  zonedParts,
} from './zoned';

const BERLIN = 'Europe/Berlin';
const HOUR = 3_600_000;
const iso = (d: Date | null) => d?.toISOString() ?? null;

// Berlin 2026: summer time starts 29 March (02:00 CET → 03:00 CEST, 02:00–02:59 don't exist) and ends
// 25 October (03:00 CEST → 02:00 CET, 02:00–02:59 happen twice).
describe('zonedInstants (wall-clock time → instants)', () => {
  it('converts ordinary winter and summer times', () => {
    expect(zonedInstants('2026-12-01', '19:00', BERLIN).map(iso)).toEqual([
      '2026-12-01T18:00:00.000Z',
    ]);
    expect(zonedInstants('2026-07-01', '19:00', BERLIN).map(iso)).toEqual([
      '2026-07-01T17:00:00.000Z',
    ]);
  });

  it('has no instant for a wall time skipped by spring forward', () => {
    expect(zonedInstants('2026-03-29', '02:00', BERLIN)).toEqual([]);
    expect(zonedInstants('2026-03-29', '02:30', BERLIN)).toEqual([]);
    expect(zonedInstants('2026-03-29', '02:59', BERLIN)).toEqual([]);
  });

  it('is exact on both sides of the spring-forward gap', () => {
    expect(zonedInstants('2026-03-29', '01:59', BERLIN).map(iso)).toEqual([
      '2026-03-29T00:59:00.000Z',
    ]);
    expect(zonedInstants('2026-03-29', '03:00', BERLIN).map(iso)).toEqual([
      '2026-03-29T01:00:00.000Z',
    ]);
  });

  it('has two instants, earlier first, for a wall time repeated by fall back', () => {
    expect(zonedInstants('2026-10-25', '02:00', BERLIN).map(iso)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
    ]);
    expect(zonedInstants('2026-10-25', '02:30', BERLIN).map(iso)).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:30:00.000Z',
    ]);
  });

  it('is exact on both sides of the fall-back repeat', () => {
    expect(zonedInstants('2026-10-25', '01:59', BERLIN).map(iso)).toEqual([
      '2026-10-24T23:59:00.000Z',
    ]);
    expect(zonedInstants('2026-10-25', '03:00', BERLIN).map(iso)).toEqual([
      '2026-10-25T02:00:00.000Z',
    ]);
  });

  it('handles zones without DST and with non-hour offsets', () => {
    expect(zonedInstants('2026-10-25', '02:30', 'UTC').map(iso)).toEqual([
      '2026-10-25T02:30:00.000Z',
    ]);
    expect(zonedInstants('2026-06-01', '12:00', 'Asia/Kolkata').map(iso)).toEqual([
      '2026-06-01T06:30:00.000Z',
    ]);
    expect(zonedInstants('2026-06-01', '12:00', 'Asia/Kathmandu').map(iso)).toEqual([
      '2026-06-01T06:15:00.000Z',
    ]);
  });

  it('follows other zones’ own switch dates (New York: 8 March, 1 November 2026)', () => {
    expect(zonedInstants('2026-03-08', '02:30', 'America/New_York')).toEqual([]);
    expect(zonedInstants('2026-11-01', '01:30', 'America/New_York').map(iso)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ]);
    // Berlin has already switched back on 1 November: one instant.
    expect(zonedInstants('2026-11-01', '01:30', BERLIN).map(iso)).toEqual([
      '2026-11-01T00:30:00.000Z',
    ]);
  });

  it('rejects malformed dates, times and zones', () => {
    expect(() => zonedInstants('2026-02-30', '19:00', BERLIN)).toThrow(RangeError);
    expect(() => zonedInstants('2026-2-1', '19:00', BERLIN)).toThrow(RangeError);
    expect(() => zonedInstants('2026-10-25', '24:00', BERLIN)).toThrow(RangeError);
    expect(() => zonedInstants('2026-10-25', '7:00', BERLIN)).toThrow(RangeError);
    expect(() => zonedInstants('2026-10-25', '19:00', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('zonedInstant (one instant or none)', () => {
  it('returns null in a gap and the earlier instant in a repeat', () => {
    expect(zonedInstant('2026-03-29', '02:30', BERLIN)).toBeNull();
    expect(iso(zonedInstant('2026-10-25', '02:30', BERLIN))).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(zonedInstant('2026-10-25', '00:00', BERLIN))).toBe('2026-10-24T22:00:00.000Z');
  });

  it('keeps the same local evening slots across the switch and moves them by an hour in UTC', () => {
    const slots = (date: string) =>
      ['17:00', '19:00', '22:45'].map((t) => iso(zonedInstant(date, t, BERLIN)));
    expect(slots('2026-03-28')).toEqual([
      '2026-03-28T16:00:00.000Z',
      '2026-03-28T18:00:00.000Z',
      '2026-03-28T21:45:00.000Z',
    ]);
    expect(slots('2026-03-29')).toEqual([
      '2026-03-29T15:00:00.000Z',
      '2026-03-29T17:00:00.000Z',
      '2026-03-29T20:45:00.000Z',
    ]);
    expect(slots('2026-10-24')).toEqual([
      '2026-10-24T15:00:00.000Z',
      '2026-10-24T17:00:00.000Z',
      '2026-10-24T20:45:00.000Z',
    ]);
    expect(slots('2026-10-25')).toEqual([
      '2026-10-25T16:00:00.000Z',
      '2026-10-25T18:00:00.000Z',
      '2026-10-25T21:45:00.000Z',
    ]);
  });
});

describe('zonedBound (a bound that always exists)', () => {
  it('moves a skipped time to the end of the gap, wherever in the gap it lies', () => {
    for (const time of ['02:00', '02:30', '02:59']) {
      expect(iso(zonedBound('2026-03-29', time, BERLIN))).toBe('2026-03-29T01:00:00.000Z');
    }
  });

  it('picks the first or last instant of a repeated time', () => {
    expect(iso(zonedBound('2026-10-25', '02:30', BERLIN))).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(zonedBound('2026-10-25', '02:30', BERLIN, 'last'))).toBe('2026-10-25T01:30:00.000Z');
    expect(iso(zonedBound('2026-07-01', '19:00', BERLIN, 'last'))).toBe('2026-07-01T17:00:00.000Z');
  });
});

describe('zonedParts (instant → wall-clock time)', () => {
  it('reads date, time and weekday in the zone', () => {
    expect(zonedParts(new Date('2026-12-31T23:30:00Z'), BERLIN)).toEqual({
      date: '2027-01-01',
      time: '00:30',
      year: 2027,
      month: 1,
      day: 1,
      hour: 0,
      minute: 30,
      weekday: 'fri',
    });
  });

  it('reads both instants of a repeated hour as the same wall time', () => {
    for (const at of ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
      expect(zonedParts(new Date(at), BERLIN)).toMatchObject({ date: '2026-10-25', time: '02:30' });
    }
  });

  it('jumps from 01:59 to 03:00 at spring forward', () => {
    expect(zonedParts(new Date('2026-03-29T00:59:00Z'), BERLIN).time).toBe('01:59');
    expect(zonedParts(new Date('2026-03-29T01:00:00Z'), BERLIN).time).toBe('03:00');
  });

  it('round-trips every quarter hour of both switch days', () => {
    for (const date of ['2026-03-29', '2026-10-25']) {
      const { start, end } = zonedDayBounds(date, BERLIN);
      for (let t = start.getTime(); t < end.getTime(); t += HOUR / 4) {
        const parts = zonedParts(new Date(t), BERLIN);
        expect(parts.date).toBe(date);
        expect(zonedInstants(parts.date, parts.time, BERLIN).map((d) => d.getTime())).toContain(t);
      }
    }
  });
});

describe('zonedDayBounds', () => {
  it('spans 24 hours on ordinary days', () => {
    const { start, end } = zonedDayBounds('2026-07-01', BERLIN);
    expect(iso(start)).toBe('2026-06-30T22:00:00.000Z');
    expect(iso(end)).toBe('2026-07-01T22:00:00.000Z');
  });

  it('spans 23 hours on the spring-forward day and 25 on the fall-back day', () => {
    const spring = zonedDayBounds('2026-03-29', BERLIN);
    expect(iso(spring.start)).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * HOUR);
    const fall = zonedDayBounds('2026-10-25', BERLIN);
    expect(iso(fall.start)).toBe('2026-10-24T22:00:00.000Z');
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * HOUR);
  });

  it('starts the day at the end of the gap when midnight itself is skipped (Santiago, 6 Sep 2026)', () => {
    const { start, end } = zonedDayBounds('2026-09-06', 'America/Santiago');
    expect(zonedParts(start, 'America/Santiago')).toMatchObject({
      date: '2026-09-06',
      time: '01:00',
    });
    expect(zonedParts(new Date(start.getTime() - 1), 'America/Santiago').date).toBe('2026-09-05');
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
  });
});

describe('local dates', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-03-29', 0)).toBe('2026-03-29');
  });

  it('names the weekday of a calendar date', () => {
    expect(weekdayOf('2026-10-31')).toBe('sat');
    expect(weekdayOf('2026-11-02')).toBe('mon');
  });

  it('validates dates and times', () => {
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalTime('00:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('12:60')).toBe(false);
  });
});
