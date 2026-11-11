import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FEATURE_KEYS,
  FEATURE_MODULES,
  FEATURES,
  featuresOfModule,
  type FeatureDefinition,
  featureLimitNames,
  featureRegistryProblems,
  isFeatureKey,
  PLAN_KEY_PATTERN,
  PLAN_KEYS,
  planLabel,
} from './features';

type Entry = Omit<FeatureDefinition, 'module' | 'order'> & { module?: string; order?: number };

const def = (
  dependsOn: string[] = [],
  limits: z.ZodObject = z.strictObject({}),
  group: { module?: string; order?: number } = {},
): Entry => ({ label: 'x.y', description: 'x.z', dependsOn, limits, ...group });

/** Every entry is its own module with a distinct order unless it says otherwise. */
const reg = (entries: Record<string, Entry>): Record<string, FeatureDefinition> =>
  Object.fromEntries(
    Object.entries(entries).map(([key, e], i) => [
      key,
      { ...e, module: e.module ?? key, order: e.order ?? i },
    ]),
  );

describe('feature registry', () => {
  it('has no problems', () => {
    expect(featureRegistryProblems(FEATURES)).toEqual([]);
  });

  it('has the phase 1 keys, then the phase 2 ones', () => {
    expect(FEATURE_KEYS).toEqual([
      'inventory',
      'inventory.counts',
      'inventory.purchasing',
      'billing',
      'billing.einvoice',
      'pos',
      'pos.fiscal',
      'reports',
      'api.public',
      'whitelabel',
      'catalog',
      'reservations',
      'reservations.online',
    ]);
  });

  // docs/modules/reservations.md → Features: reservations needs pos tables, the widget needs reservations.
  it('makes reservations depend on pos and the online widget on reservations', () => {
    expect(FEATURES.reservations.dependsOn).toEqual(['pos']);
    expect(FEATURES['reservations.online'].dependsOn).toEqual(['reservations']);
    expect(featureLimitNames('reservations')).toEqual([]);
    expect(featureLimitNames('reservations.online')).toEqual([]);
  });

  it('gives every key a name and description label key', () => {
    for (const key of FEATURE_KEYS) {
      expect(FEATURES[key].label).toMatch(/^platform\.features\.[a-z][a-zA-Z0-9]*\.name$/);
      expect(FEATURES[key].description).toBe(
        FEATURES[key].label.replace(/\.name$/, '.description'),
      );
    }
  });

  it('recognizes registered keys only', () => {
    expect(isFeatureKey('inventory.counts')).toBe(true);
    expect(isFeatureKey('inventory.everything')).toBe(false);
    expect(isFeatureKey('toString')).toBe(false);
  });

  it('validates limits against the feature schema', () => {
    const inventory = FEATURES.inventory.limits;
    expect(inventory.safeParse({}).success).toBe(true);
    expect(inventory.safeParse({ maxLocations: 5 }).success).toBe(true);
    expect(inventory.safeParse({ maxLocations: 0 }).success).toBe(false);
    expect(inventory.safeParse({ maxLocations: 1.5 }).success).toBe(false);
    expect(inventory.safeParse({ maxLocations: '5' }).success).toBe(false);
    expect(inventory.safeParse({ maxUsers: 5 }).success).toBe(false);
    expect(FEATURES['inventory.counts'].limits.safeParse({ anything: 1 }).success).toBe(false);
  });

  it('lists limit names', () => {
    expect(featureLimitNames('inventory')).toEqual(['maxLocations']);
    expect(featureLimitNames('api.public')).toEqual(['requestsPerMinute']);
    expect(featureLimitNames('reports')).toEqual([]);
  });
});

describe('featureRegistryProblems', () => {
  it('reports unknown dependencies', () => {
    expect(featureRegistryProblems(reg({ a: def(['b']) }))).toEqual(['a: unknown dependency b']);
  });

  it('reports cycles, including self-dependencies', () => {
    expect(featureRegistryProblems(reg({ a: def(['a']) }))).toEqual(['dependency cycle: a → a']);
    expect(featureRegistryProblems(reg({ a: def(['b']), b: def(['c']), c: def(['a']) }))).toEqual([
      'dependency cycle: a → b → c → a',
    ]);
  });

  it('accepts shared dependencies that are not cycles', () => {
    expect(featureRegistryProblems(reg({ a: def(), b: def(['a']), c: def(['a', 'b']) }))).toEqual(
      [],
    );
  });

  it('reports bad keys and limits schemas', () => {
    expect(
      featureRegistryProblems(
        reg({
          'Bad-Key': def(),
          loose: def([], z.object({ n: z.number().optional() })),
          required: def([], z.strictObject({ n: z.number() })),
        }),
      ),
    ).toEqual([
      'Bad-Key: key must match /^[a-z]+(\\.[a-z_]+)*$/',
      'loose: limits schema must be strict',
      'required: every limit must be optional',
    ]);
  });

  // A new module can't merge without a group the portal can show (admin portal 1d).
  it('reports a module group that is not a registered module key', () => {
    expect(featureRegistryProblems(reg({ a: def([], undefined, { module: 'nope' }) }))).toEqual([
      'a: module nope must be a registered module key',
    ]);
    expect(
      featureRegistryProblems(
        reg({
          a: def(),
          b: def(['a'], undefined, { module: 'a' }),
          c: def(['b'], undefined, { module: 'b' }),
        }),
      ),
    ).toEqual(['c: module b must be a registered module key']);
  });

  it('reports a sub-feature that does not depend on its module', () => {
    expect(
      featureRegistryProblems(
        reg({ a: def(), x: def(), b: def(['x'], undefined, { module: 'a' }) }),
      ),
    ).toEqual(['b: must depend on its module a']);
    // Transitive is enough.
    expect(
      featureRegistryProblems(
        reg({
          a: def(),
          b: def(['a'], undefined, { module: 'a', order: 1 }),
          c: def(['b'], undefined, { module: 'a', order: 2 }),
        }),
      ),
    ).toEqual([]);
  });

  it('reports siblings with the same order and bad orders', () => {
    expect(
      featureRegistryProblems(
        reg({
          a: def([], undefined, { order: 1 }),
          b: def([], undefined, { order: 1 }),
          c: def(['a'], undefined, { module: 'a', order: 1 }),
          d: def([], undefined, { order: 1.5 }),
        }),
      ),
    ).toEqual([
      'd: order must be a non-negative integer',
      'b: order 1 already used by a in (modules)',
    ]);
  });
});

describe('modules', () => {
  it('lists the module keys in portal order and their sub-features', () => {
    expect(FEATURE_MODULES).toEqual([
      'catalog',
      'pos',
      'inventory',
      'reservations',
      'billing',
      'reports',
      'api.public',
      'whitelabel',
    ]);
    expect(featuresOfModule('inventory')).toEqual(['inventory.counts', 'inventory.purchasing']);
    expect(featuresOfModule('pos')).toEqual(['pos.fiscal']);
    expect(featuresOfModule('catalog')).toEqual([]);
  });

  it('puts every key in exactly one module', () => {
    const grouped = FEATURE_MODULES.flatMap((m) => [m, ...featuresOfModule(m)]);
    expect([...grouped].sort()).toEqual([...FEATURE_KEYS].sort());
  });

  // POS sells catalog products: no customer has POS without the catalog.
  it('makes pos depend on catalog', () => {
    expect(FEATURES.pos.dependsOn).toEqual(['catalog']);
  });
});

describe('plans', () => {
  it('uses plan keys of the SQL shape with a label key', () => {
    for (const key of PLAN_KEYS) expect(key).toMatch(PLAN_KEY_PATTERN);
    expect(planLabel('inventory_billing')).toBe('platform.plans.inventoryBilling');
  });
});
