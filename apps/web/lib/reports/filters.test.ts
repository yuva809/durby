import { describe, expect, it } from 'vitest';
import { reportQuery } from './api';
import { filterFromParams, rangeOf } from './filters';

const TODAY = '2026-11-24';
const filter = (query: string) => filterFromParams(new URLSearchParams(query), TODAY);

describe('report filters', () => {
  it('turns presets into business days', () => {
    expect(rangeOf('today', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(rangeOf('yesterday', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(rangeOf('last7', TODAY)).toEqual({ from: '2026-11-18', to: TODAY });
    expect(rangeOf('last28', TODAY)).toEqual({ from: '2026-10-28', to: TODAY });
    expect(rangeOf('month', TODAY)).toEqual({ from: '2026-11-01', to: TODAY });
  });

  it('reads the address, last 7 days by default', () => {
    expect(filter('')).toEqual({ from: '2026-11-18', to: TODAY, locationId: null });
    expect(filter('period=bogus&location=abc')?.locationId).toBe('abc');
    expect(filter('period=custom&from=2026-01-01&to=2026-01-31')).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      locationId: null,
    });
  });

  it('asks nothing with a period the api refuses', () => {
    expect(filter('period=custom')).toBeNull();
    expect(filter('period=custom&from=2026-02-01&to=2026-01-01')).toBeNull();
    expect(filter('period=custom&from=2025-01-01&to=2026-11-24')).toBeNull();
    expect(filter('period=custom&from=2026-02-30&to=2026-03-01')).toBeNull();
  });

  it('builds the query', () => {
    expect(reportQuery({ from: 'a', to: 'b', locationId: null })).toBe('?from=a&to=b');
    expect(reportQuery({ from: 'a', to: 'b', locationId: 'l' })).toBe('?from=a&to=b&locationId=l');
  });
});
