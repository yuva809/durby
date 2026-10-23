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

const override = (featureKey: string, enabled: boolean, limits: unknown = null) => ({
  featureKey,
  enabled,
  limits,
});

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
});
