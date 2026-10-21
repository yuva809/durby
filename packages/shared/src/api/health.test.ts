import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a valid health payload', () => {
    const payload = { status: 'ok', version: '0.0.0', time: '2026-10-21T12:00:00.000Z' };
    expect(healthResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a non-ok status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'down',
      version: '0.0.0',
      time: '2026-10-21T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO time', () => {
    const result = healthResponseSchema.safeParse({ status: 'ok', version: '0.0.0', time: 'now' });
    expect(result.success).toBe(false);
  });
});
