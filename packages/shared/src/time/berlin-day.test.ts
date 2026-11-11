import { describe, expect, it } from 'vitest';
import { berlinDate, berlinEndOfDay, isPastBerlinDay } from './berlin-day';

describe('berlinEndOfDay', () => {
  it('ends a winter day at 23:59:59.999 CET (UTC+1)', () => {
    expect(berlinEndOfDay('2026-11-20').toISOString()).toBe('2026-11-20T22:59:59.999Z');
  });

  it('ends a summer day at 23:59:59.999 CEST (UTC+2)', () => {
    expect(berlinEndOfDay('2026-07-01').toISOString()).toBe('2026-07-01T21:59:59.999Z');
  });

  // DST change days: the day itself has 23 or 25 hours; its end is in the new offset.
  it('ends the spring-forward day (2026-03-29) in CEST', () => {
    expect(berlinEndOfDay('2026-03-29').toISOString()).toBe('2026-03-29T21:59:59.999Z');
    expect(berlinEndOfDay('2026-03-28').toISOString()).toBe('2026-03-28T22:59:59.999Z');
  });

  it('ends the fall-back day (2026-10-25) in CET', () => {
    expect(berlinEndOfDay('2026-10-25').toISOString()).toBe('2026-10-25T22:59:59.999Z');
    expect(berlinEndOfDay('2026-10-24').toISOString()).toBe('2026-10-24T21:59:59.999Z');
  });

  it('shows the stored instant as the same Berlin day', () => {
    for (const day of ['2026-03-28', '2026-03-29', '2026-10-25', '2026-12-31', '2027-01-01']) {
      expect(berlinDate(berlinEndOfDay(day))).toBe(day);
    }
  });

  it('rejects malformed days', () => {
    expect(() => berlinEndOfDay('2026-02-30')).toThrow(RangeError);
    expect(() => berlinEndOfDay('tomorrow')).toThrow(RangeError);
  });
});

describe('isPastBerlinDay', () => {
  // 23:30 UTC on 11 Nov is already 12 Nov in Berlin.
  const lateEvening = new Date('2026-11-11T23:30:00Z');

  it('judges "past" by the Berlin day, not the UTC one', () => {
    expect(isPastBerlinDay('2026-11-11', lateEvening)).toBe(true);
    expect(isPastBerlinDay('2026-11-12', lateEvening)).toBe(false);
  });

  it('allows today', () => {
    expect(isPastBerlinDay('2026-11-11', new Date('2026-11-11T08:00:00Z'))).toBe(false);
  });
});
