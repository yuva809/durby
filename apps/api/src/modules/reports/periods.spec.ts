import { businessDay } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { cardSpans, daysSpan, weekStart } from './periods';

const berlin = { timeZone: 'Europe/Berlin', dayStartsAt: '04:00' };
const iso = (span: { start: Date; end: Date }) => [
  span.start.toISOString(),
  span.end.toISOString(),
];

describe('business days (ADR 0081)', () => {
  it('count the hours after midnight to the day before', () => {
    // Saturday 28 Nov 2026, 01:30 in Berlin (UTC+1) is still Friday.
    expect(businessDay(new Date('2026-11-28T00:30:00Z'), berlin)).toBe('2026-11-27');
    expect(businessDay(new Date('2026-11-28T02:59:59Z'), berlin)).toBe('2026-11-27');
    expect(businessDay(new Date('2026-11-28T03:00:00Z'), berlin)).toBe('2026-11-28');
    expect(businessDay(new Date('2026-11-28T00:30:00Z'), { ...berlin, dayStartsAt: '00:00' })).toBe(
      '2026-11-28',
    );
  });

  it('follow the zone of the location', () => {
    const at = new Date('2026-11-28T00:30:00Z');
    expect(businessDay(at, { timeZone: 'Asia/Kolkata', dayStartsAt: '04:00' })).toBe('2026-11-28');
    expect(businessDay(at, { timeZone: 'America/New_York', dayStartsAt: '04:00' })).toBe(
      '2026-11-27',
    );
  });

  it('run from start to start, 23 or 25 hours on switch days', () => {
    expect(iso(daysSpan('2026-11-27', '2026-11-27', berlin))).toEqual([
      '2026-11-27T03:00:00.000Z',
      '2026-11-28T03:00:00.000Z',
    ]);
    const hours = (day: string) => {
      const { start, end } = daysSpan(day, day, berlin);
      return (end.getTime() - start.getTime()) / 3_600_000;
    };
    // Switches at 02:00/03:00 on Sundays 29 Mar and 25 Oct 2026: inside the Saturday business day (until 04:00).
    expect(hours('2026-03-28')).toBe(23);
    expect(hours('2026-03-29')).toBe(24);
    expect(hours('2026-10-24')).toBe(25);
    expect(hours('2026-10-25')).toBe(24);
    // A day starting in the skipped hour starts when the gap ends (03:00 = 01:00 UTC).
    expect(
      daysSpan('2026-03-29', '2026-03-29', { ...berlin, dayStartsAt: '02:00' }).start.toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
  });

  it('weeks start on Monday', () => {
    expect(weekStart('2026-11-24')).toBe('2026-11-23');
    expect(weekStart('2026-11-23')).toBe('2026-11-23');
    expect(weekStart('2026-11-29')).toBe('2026-11-23');
  });
});

describe('cardSpans', () => {
  it('compares with the same weekday up to the same wall-clock time', () => {
    // Tuesday 24 Nov 2026, 18:00 in Berlin.
    const spans = cardSpans(new Date('2026-11-24T17:00:00Z'), berlin);
    expect(iso(spans.today.figures)).toEqual([
      '2026-11-24T03:00:00.000Z',
      '2026-11-24T17:00:00.000Z',
    ]);
    expect(iso(spans.today.compare)).toEqual([
      '2026-11-17T03:00:00.000Z',
      '2026-11-17T17:00:00.000Z',
    ]);
    expect(iso(spans.yesterday.figures)).toEqual([
      '2026-11-23T03:00:00.000Z',
      '2026-11-24T03:00:00.000Z',
    ]);
    expect(iso(spans.yesterday.compare)).toEqual([
      '2026-11-16T03:00:00.000Z',
      '2026-11-17T03:00:00.000Z',
    ]);
    expect(iso(spans.week.figures)).toEqual([
      '2026-11-23T03:00:00.000Z',
      '2026-11-24T17:00:00.000Z',
    ]);
    expect(iso(spans.week.compare)).toEqual([
      '2026-11-16T03:00:00.000Z',
      '2026-11-17T17:00:00.000Z',
    ]);
  });

  it('after midnight still belongs to the evening, also a week earlier', () => {
    // Wednesday 01:30 in Berlin: business day Tuesday.
    const spans = cardSpans(new Date('2026-11-25T00:30:00Z'), berlin);
    expect(iso(spans.today.figures)).toEqual([
      '2026-11-24T03:00:00.000Z',
      '2026-11-25T00:30:00.000Z',
    ]);
    expect(iso(spans.today.compare)).toEqual([
      '2026-11-17T03:00:00.000Z',
      '2026-11-18T00:30:00.000Z',
    ]);
  });

  it('keeps the wall-clock time across a switch', () => {
    // Tuesday 27 Oct 2026 12:00 Berlin (UTC+1); a week earlier it was UTC+2.
    const spans = cardSpans(new Date('2026-10-27T11:00:00Z'), berlin);
    expect(iso(spans.today.compare)).toEqual([
      '2026-10-20T02:00:00.000Z',
      '2026-10-20T10:00:00.000Z',
    ]);
  });
});
