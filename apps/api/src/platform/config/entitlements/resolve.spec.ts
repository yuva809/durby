import { describe, expect, it } from 'vitest';
import { type EntitlementRows, resolveEntitlements } from './resolve';

const plan = (
  key: string,
  ...features: (string | [string, unknown])[]
): EntitlementRows['plan'] => ({
  key,
  features: features.map((f) =>
    typeof f === 'string' ? { featureKey: f, limits: null } : { featureKey: f[0], limits: f[1] },
  ),
});

const override = (
  featureKey: string,
  enabled: boolean,
  limits: unknown = null,
  expiresAt: Date | null = null,
) => ({ featureKey, enabled, limits, expiresAt });

const NOW = new Date('2026-11-11T12:00:00Z');

const keys = (rows: EntitlementRows) => [...resolveEntitlements(rows).features.keys()];

describe('resolveEntitlements', () => {
  it('enables nothing without a plan or overrides', () => {
    const resolved = resolveEntitlements({ plan: null, overrides: [] });
    expect(resolved.planKey).toBeNull();
    expect(resolved.features.size).toBe(0);
  });

  it('enables the plan features, in registry order', () => {
    expect(
      keys({ plan: plan('p', 'reports', 'inventory.counts', 'inventory'), overrides: [] }),
    ).toEqual(['inventory', 'inventory.counts', 'reports']);
  });

  it('lets an override enable or disable, whatever the plan says', () => {
    const rows = {
      plan: plan('p', 'inventory', 'reports'),
      overrides: [override('reports', false), override('billing', true)],
    };
    expect(keys(rows)).toEqual(['inventory', 'billing']);
  });

  it('disables a feature whose dependency is disabled, transitively and by override', () => {
    expect(keys({ plan: plan('p', 'inventory.counts'), overrides: [] })).toEqual([]);
    expect(keys({ plan: null, overrides: [override('inventory.counts', true)] })).toEqual([]);
    expect(
      keys({
        plan: plan('p', 'inventory', 'inventory.counts'),
        overrides: [override('inventory', false)],
      }),
    ).toEqual([]);
  });

  it('merges limits per name: override → plan → unlimited', () => {
    const resolved = resolveEntitlements({
      plan: plan('p', ['inventory', { maxLocations: 3 }], 'api.public'),
      overrides: [override('api.public', true, { requestsPerMinute: 60 })],
    });
    expect(resolved.features.get('inventory')).toEqual({ maxLocations: 3 });
    expect(resolved.features.get('api.public')).toEqual({ requestsPerMinute: 60 });

    const overridden = resolveEntitlements({
      plan: plan('p', ['inventory', { maxLocations: 3 }]),
      overrides: [override('inventory', true, { maxLocations: 10 })],
    });
    expect(overridden.features.get('inventory')).toEqual({ maxLocations: 10 });

    const unlimited = resolveEntitlements({
      plan: plan('p', 'inventory', 'reports'),
      overrides: [],
    });
    expect(unlimited.features.get('inventory')).toEqual({ maxLocations: null });
    expect(unlimited.features.get('reports')).toEqual({});
  });

  it('ignores unregistered keys and invalid limits (fail closed) and reports them', () => {
    const ignored: string[] = [];
    const resolved = resolveEntitlements(
      {
        plan: plan('p', 'inventory.everything', ['inventory', { maxLocations: -1, maxUsers: 5 }]),
        overrides: [override('pos.anything', true), override('api.public', true, [1])],
      },
      (problem) => ignored.push(problem),
    );
    expect([...resolved.features.keys()]).toEqual(['inventory', 'api.public']);
    expect(resolved.features.get('inventory')).toEqual({ maxLocations: null });
    expect(ignored.sort()).toEqual([
      'override limits of api.public are not an object',
      'plan limit inventory.maxLocations is invalid',
      'plan limit inventory.maxUsers is unregistered',
      'unregistered feature key inventory.everything',
      'unregistered feature key pos.anything',
    ]);
  });

  // Admin portal 1d: an expired override counts as absent, so the plan applies again.
  describe('expiry', () => {
    const resolveAt = (rows: EntitlementRows, now: Date) => [
      ...resolveEntitlements(rows, undefined, now).features.keys(),
    ];

    it('ignores an override that expired (at or before now)', () => {
      const rows = {
        plan: plan('p', 'inventory'),
        overrides: [
          override('inventory', false, null, new Date('2026-11-10T22:59:59.999Z')),
          override('reports', true, null, NOW),
        ],
      };
      expect(resolveAt(rows, NOW)).toEqual(['inventory']);
    });

    it('applies an override until it expires', () => {
      const rows = {
        plan: plan('p', 'inventory'),
        overrides: [
          override('inventory', false, null, new Date('2026-11-12T22:59:59.999Z')),
          override('reports', true, null, new Date('2026-11-12T22:59:59.999Z')),
        ],
      };
      expect(resolveAt(rows, NOW)).toEqual(['reports']);
      expect(resolveAt(rows, new Date('2026-11-12T23:00:00Z'))).toEqual(['inventory']);
    });

    it('drops the limits of an expired override too', () => {
      const rows = {
        plan: plan('p', ['inventory', { maxLocations: 2 }]),
        overrides: [
          override('inventory', true, { maxLocations: 9 }, new Date('2026-11-01T00:00:00Z')),
        ],
      };
      expect(resolveEntitlements(rows, undefined, NOW).features.get('inventory')).toEqual({
        maxLocations: 2,
      });
    });
  });

  // POS sells catalog products: pos stays off while catalog is (admin portal 1d).
  it('enforces pos → catalog', () => {
    expect(keys({ plan: plan('p', 'pos'), overrides: [] })).toEqual([]);
    expect(keys({ plan: plan('p', 'pos', 'catalog'), overrides: [] })).toEqual(['pos', 'catalog']);
    expect(
      keys({ plan: plan('p', 'pos', 'catalog'), overrides: [override('catalog', false)] }),
    ).toEqual([]);
    // reservations → pos → catalog, transitively.
    expect(keys({ plan: plan('p', 'pos', 'reservations'), overrides: [] })).toEqual([]);
  });
});
