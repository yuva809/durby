import { businessDay } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { cardSpans, dailyReportDue, daysSpan, normalDay, normalDayOf, weekStart } from './periods';

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

describe('normal day (ADR 0082)', () => {
  it('is the four same weekdays before the last whole business day', () => {
    // Tuesday 24 Nov 2026, 18:00 in Berlin: yesterday is Monday the 23rd.
    const { day, yesterday, before } = normalDay(new Date('2026-11-24T17:00:00Z'), berlin);
    expect(day).toBe('2026-11-23');
    expect(iso(yesterday)).toEqual(['2026-11-23T03:00:00.000Z', '2026-11-24T03:00:00.000Z']);
    expect(before.map((s) => s.start.toISOString())).toEqual([
      '2026-11-16T03:00:00.000Z',
      '2026-11-09T03:00:00.000Z',
      '2026-11-02T03:00:00.000Z',
      '2026-10-26T03:00:00.000Z',
    ]);
    expect(iso(before[3]!)[1]).toBe('2026-10-27T03:00:00.000Z');
  });

  it('at 01:30 yesterday is still the day before the running one', () => {
    expect(normalDay(new Date('2026-11-25T00:30:00Z'), berlin).day).toBe('2026-11-23');
    expect(normalDay(new Date('2026-11-25T03:00:00Z'), berlin).day).toBe('2026-11-24');
  });

  it('keeps whole business days across both switches', () => {
    const hours = ({ start, end }: { start: Date; end: Date }) =>
      (end.getTime() - start.getTime()) / 3_600_000;
    // Yesterday Saturday 31 Oct 2026; a week before it, the 25-hour Saturday of the switch.
    const autumn = normalDay(new Date('2026-11-01T12:00:00Z'), berlin);
    expect(autumn.day).toBe('2026-10-31');
    expect(hours(autumn.yesterday)).toBe(24);
    expect(autumn.before.map(hours)).toEqual([25, 24, 24, 24]);
    expect(autumn.before[1]!.start.toISOString()).toBe('2026-10-17T02:00:00.000Z');
    // Yesterday Saturday 4 Apr 2026; a week before it, the 23-hour one.
    const spring = normalDay(new Date('2026-04-05T12:00:00Z'), berlin);
    expect(spring.before.map(hours)).toEqual([23, 24, 24, 24]);
    expect(spring.before[1]!.start.toISOString()).toBe('2026-03-21T03:00:00.000Z');
  });
});

describe('daily report (ADR 0083)', () => {
  const due = (now: string, clocks = [berlin], sendAt = '08:00') =>
    dailyReportDue(new Date(now), { timeZone: 'Europe/Berlin', sendAt, clocks });

  it('is about yesterday, at the set time, for twelve hours', () => {
    // 08:00 in Berlin is 07:00 UTC in winter.
    expect(due('2026-11-24T06:59:59Z')).toEqual({ day: '2026-11-23', state: 'early' });
    expect(due('2026-11-24T07:00:00Z')).toEqual({ day: '2026-11-23', state: 'due' });
    expect(due('2026-11-24T18:59:59Z')).toEqual({ day: '2026-11-23', state: 'due' });
    expect(due('2026-11-24T19:00:00Z')).toEqual({ day: '2026-11-23', state: 'late' });
    expect(due('2026-11-24T05:30:00Z', [berlin], '06:00').state).toBe('due');
    // After midnight the next day's report is still far away.
    expect(due('2026-11-24T23:30:00Z')).toEqual({ day: '2026-11-24', state: 'early' });
  });

  it('keeps the wall-clock time across both switches', () => {
    expect(due('2026-03-29T05:59:59Z').state).toBe('early');
    expect(due('2026-03-29T06:00:00Z')).toEqual({ day: '2026-03-28', state: 'due' });
    expect(due('2026-10-25T06:59:59Z').state).toBe('early');
    expect(due('2026-10-25T07:00:00Z')).toEqual({ day: '2026-10-24', state: 'due' });
  });

  it('waits until the day has ended everywhere', () => {
    const newYork = { timeZone: 'America/New_York', dayStartsAt: '04:00' };
    // 04:00 in New York is 09:00 UTC.
    expect(due('2026-11-24T08:59:59Z', [berlin, newYork]).state).toBe('early');
    expect(due('2026-11-24T09:00:00Z', [berlin, newYork]).state).toBe('due');
    const late = { ...berlin, dayStartsAt: '08:00' };
    expect(due('2026-11-24T06:59:59Z', [late], '06:00').state).toBe('early');
    expect(due('2026-11-24T07:00:00Z', [late], '06:00').state).toBe('due');
  });

  it('a day is the same days as on the overview', () => {
    const now = new Date('2026-11-24T07:00:00Z');
    expect(normalDayOf('2026-11-23', berlin)).toEqual(normalDay(now, berlin));
  });
});
