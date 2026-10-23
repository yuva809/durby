import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_ERROR_CODES,
  idempotencyErrorLabel,
  idempotencyKeySchema,
} from './idempotency';

describe('idempotency key', () => {
  it('accepts 1–255 visible ASCII characters', () => {
    const ok = (key: string) => idempotencyKeySchema.safeParse(key).success;
    expect(ok('0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f60')).toBe(true);
    expect(ok('x')).toBe(true);
    expect(ok('x'.repeat(255))).toBe(true);
    expect(ok('')).toBe(false);
    expect(ok('x'.repeat(256))).toBe(false);
    expect(ok('has space')).toBe(false);
    expect(ok('ümlaut')).toBe(false);
    expect(ok('tab\t')).toBe(false);
  });

  it('derives error labels from codes', () => {
    expect(IDEMPOTENCY_ERROR_CODES.map(idempotencyErrorLabel)).toEqual([
      'platform.errors.idempotencyKeyRequired',
      'platform.errors.idempotencyKeyInvalid',
      'platform.errors.idempotencyKeyReused',
      'platform.errors.idempotencyRequestInProgress',
    ]);
  });
});
