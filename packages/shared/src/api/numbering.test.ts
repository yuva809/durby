import { describe, expect, it } from 'vitest';
import {
  counterValueSchema,
  NUMBERING_ERROR_CODES,
  numberingErrorLabel,
  patchNumberSeriesRequestSchema,
  putNumberSeriesCounterRequestSchema,
} from './numbering';

describe('number series API schemas', () => {
  it('accepts counter values within bigint only, as strings', () => {
    for (const ok of ['1', '42', '9223372036854775807']) {
      expect(counterValueSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['0', '-1', '01', '1.5', '9223372036854775808', '', 42]) {
      expect(counterValueSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('needs at least one field to patch and rejects unknown ones', () => {
    expect(patchNumberSeriesRequestSchema.safeParse({ prefix: 'RE' }).success).toBe(true);
    expect(patchNumberSeriesRequestSchema.safeParse({}).success).toBe(false);
    expect(patchNumberSeriesRequestSchema.safeParse({ nextValue: '5' }).success).toBe(false);
    expect(patchNumberSeriesRequestSchema.safeParse({ resetPolicy: 'monthly' }).success).toBe(
      false,
    );
  });

  it('takes an optional period shaped like the counter CHECK', () => {
    const parse = (body: unknown) => putNumberSeriesCounterRequestSchema.safeParse(body).success;
    expect(parse({ nextValue: '100' })).toBe(true);
    expect(parse({ nextValue: '100', period: '2027' })).toBe(true);
    expect(parse({ nextValue: '100', period: 'all' })).toBe(true);
    expect(parse({ nextValue: '100', period: '27' })).toBe(false);
  });

  it('derives error labels from codes', () => {
    expect(NUMBERING_ERROR_CODES.map(numberingErrorLabel)).toContain(
      'platform.errors.numberingCounterBackwards',
    );
  });
});
