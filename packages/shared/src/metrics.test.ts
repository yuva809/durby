import { describe, expect, it } from 'vitest';
import { reportQuerySchema } from './api/reports';
import { FEATURE_KEYS } from './features';
import { METRIC_KEYS, METRIC_UNITS, METRICS } from './metrics';
import { PERMISSION_KEYS } from './permissions';

describe('metric registry', () => {
  it('gives every metric registered keys, a unit and labels of its own', () => {
    for (const key of METRIC_KEYS) {
      const metric = METRICS[key];
      expect(METRIC_UNITS).toContain(metric.unit);
      expect(FEATURE_KEYS).toContain(metric.feature);
      expect(PERMISSION_KEYS).toContain(metric.permission);
    }
    expect(new Set(METRIC_KEYS.map((k) => METRICS[k].label)).size).toBe(METRIC_KEYS.length);
  });
});

describe('reportQuerySchema', () => {
  const ok = (from: string, to: string) => reportQuerySchema.safeParse({ from, to }).success;

  it('takes up to 366 real days in order', () => {
    expect(ok('2026-11-24', '2026-11-24')).toBe(true);
    expect(ok('2026-01-01', '2027-01-01')).toBe(true);
    expect(ok('2026-01-01', '2027-01-02')).toBe(false);
    expect(ok('2026-11-25', '2026-11-24')).toBe(false);
    expect(ok('2026-02-30', '2026-03-01')).toBe(false);
    expect(ok('nonsense', '2026-03-01')).toBe(false);
  });
});
