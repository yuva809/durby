import { describe, expect, it } from 'vitest';
import { healthResponseSchema, liveResponseSchema } from './health';

const time = '2026-10-21T12:00:00.000Z';
const healthy = {
  status: 'ok',
  version: '0.0.0',
  time,
  checks: { database: 'up', redis: 'up' },
};

describe('healthResponseSchema', () => {
  it('accepts a healthy payload', () => {
    expect(healthResponseSchema.parse(healthy)).toEqual(healthy);
  });

  it('accepts a degraded payload', () => {
    const degraded = { ...healthy, status: 'degraded', checks: { database: 'up', redis: 'down' } };
    expect(healthResponseSchema.parse(degraded)).toEqual(degraded);
  });

  it('rejects an unknown status', () => {
    expect(healthResponseSchema.safeParse({ ...healthy, status: 'down' }).success).toBe(false);
  });

  it('rejects a payload without checks', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', version: '0.0.0', time }).success).toBe(
      false,
    );
  });

  it('rejects a non-ISO time', () => {
    expect(healthResponseSchema.safeParse({ ...healthy, time: 'now' }).success).toBe(false);
  });
});

describe('liveResponseSchema', () => {
  it('accepts an ok payload', () => {
    const payload = { status: 'ok', version: '0.0.0', time };
    expect(liveResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a non-ok status', () => {
    expect(liveResponseSchema.safeParse({ status: 'degraded', version: '0', time }).success).toBe(
      false,
    );
  });
});
