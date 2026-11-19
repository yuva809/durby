import { describe, expect, it } from 'vitest';
import { earliestDate, isExpired, today } from './expiry';

describe('best-before dates (ADR 0062)', () => {
  it('is past the day after its date, not on it', () => {
    expect(isExpired('2026-11-18', '2026-11-19')).toBe(true);
    expect(isExpired('2026-11-19', '2026-11-19')).toBe(false);
    expect(isExpired('2027-01-01', '2026-11-19')).toBe(false);
  });

  it('takes the earliest of some dates, ignoring none', () => {
    expect(earliestDate(['2027-05-01', null, '2027-03-31'])).toBe('2027-03-31');
    expect(earliestDate([null, null])).toBeNull();
  });

  it("writes today in the viewer's own calendar", () => {
    expect(today(new Date(2026, 10, 9, 23, 30))).toBe('2026-11-09');
  });
});
