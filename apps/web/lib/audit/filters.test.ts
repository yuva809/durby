import { describe, expect, it } from 'vitest';
import {
  apiQuery,
  dayStart,
  filtersFromParams,
  isDay,
  nextDay,
  paramsFromFilters,
} from './filters';

const ACTOR = '0190a000-0000-7000-8000-000000000001';

describe('audit filters in the URL', () => {
  it('round-trips through the URL', () => {
    const filters = {
      action: 'platform.setting_value.updated' as const,
      entityType: 'setting_value' as const,
      actor: ACTOR,
      from: '2026-10-01',
      to: '2026-10-26',
    };
    const params = paramsFromFilters(filters);
    expect(params.toString()).toBe(
      `action=platform.setting_value.updated&entityType=setting_value&actor=${ACTOR}&from=2026-10-01&to=2026-10-26`,
    );
    expect(filtersFromParams(params)).toEqual(filters);
  });

  it('drops unknown and malformed values instead of sending them', () => {
    expect(
      filtersFromParams(
        new URLSearchParams(
          'action=drop.tables&entityType=user&actor=nobody&from=2026-02-30&to=yesterday',
        ),
      ),
    ).toEqual({});
    // A range ending before it starts keeps only the start.
    expect(filtersFromParams(new URLSearchParams('from=2026-10-10&to=2026-10-01'))).toEqual({
      from: '2026-10-10',
    });
    expect(paramsFromFilters({}).toString()).toBe('');
  });

  it('keeps module, branch and search in the URL; sends module and branch, never the search', () => {
    const location = '0190a000-0000-7000-8000-000000000002';
    const params = new URLSearchParams(`module=inventory&location=${location}&q=%20tomato%20`);
    const filters = filtersFromParams(params);
    expect(filters).toEqual({ module: 'inventory', location, q: 'tomato' });
    expect(apiQuery(filters, 'UTC').toString()).toBe(`module=inventory&locationId=${location}`);
    expect(filtersFromParams(new URLSearchParams('module=billingz&location=x'))).toEqual({});
  });

  it('knows real calendar days', () => {
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2026-1-5')).toBe(false);
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });
});

describe('day bounds in the organization time zone', () => {
  it('starts a day at local midnight, with the offset of that day', () => {
    expect(dayStart('2026-07-01', 'Europe/Berlin')).toBe('2026-06-30T22:00:00.000Z'); // CEST
    expect(dayStart('2026-12-01', 'Europe/Berlin')).toBe('2026-11-30T23:00:00.000Z'); // CET
    expect(dayStart('2026-10-26', 'UTC')).toBe('2026-10-26T00:00:00.000Z');
    expect(dayStart('2026-10-26', 'America/New_York')).toBe('2026-10-26T04:00:00.000Z');
    expect(dayStart('2026-10-26', 'Asia/Kolkata')).toBe('2026-10-25T18:30:00.000Z');
  });

  it('handles the days daylight saving time changes', () => {
    // Berlin: summer time ends 2026-10-25 (day has 25 h), starts 2026-03-29 (23 h).
    expect(dayStart('2026-10-25', 'Europe/Berlin')).toBe('2026-10-24T22:00:00.000Z');
    expect(dayStart('2026-10-26', 'Europe/Berlin')).toBe('2026-10-25T23:00:00.000Z');
    expect(dayStart('2026-03-29', 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z');
    expect(dayStart('2026-03-30', 'Europe/Berlin')).toBe('2026-03-29T22:00:00.000Z');
  });

  it('sends from inclusive and to as the start of the next day (exclusive)', () => {
    const query = apiQuery(
      { action: 'platform.role.created', actor: ACTOR, from: '2026-10-25', to: '2026-10-25' },
      'Europe/Berlin',
    );
    expect(Object.fromEntries(query)).toEqual({
      action: 'platform.role.created',
      actorUserId: ACTOR,
      from: '2026-10-24T22:00:00.000Z',
      to: '2026-10-25T23:00:00.000Z',
    });
  });
});
