import { describe, expect, it } from 'vitest';
import { meEntitlementsResponseSchema } from './entitlements';

describe('meEntitlementsResponseSchema', () => {
  it('accepts enabled features with limits (null = unlimited)', () => {
    const body = {
      plan: { key: 'full' },
      features: [
        { key: 'inventory', limits: { maxLocations: null } },
        { key: 'reports', limits: {} },
      ],
    };
    expect(meEntitlementsResponseSchema.parse(body)).toEqual(body);
    expect(meEntitlementsResponseSchema.parse({ plan: null, features: [] })).toEqual({
      plan: null,
      features: [],
    });
  });

  it('rejects unregistered keys and non-integer limits', () => {
    const parse = (features: unknown) =>
      meEntitlementsResponseSchema.safeParse({ plan: null, features }).success;
    expect(parse([{ key: 'inventory.everything', limits: {} }])).toBe(false);
    expect(parse([{ key: 'inventory', limits: { maxLocations: '5' } }])).toBe(false);
    expect(parse([{ key: 'inventory', limits: { maxLocations: 0 } }])).toBe(false);
  });
});
