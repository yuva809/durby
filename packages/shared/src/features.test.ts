import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FEATURE_KEYS,
  FEATURES,
  type FeatureDefinition,
  featureLimitNames,
  featureRegistryProblems,
  isFeatureKey,
  PLAN_KEY_PATTERN,
  PLAN_KEYS,
  planLabel,
} from './features';

const def = (dependsOn: string[] = [], limits: z.ZodObject = z.strictObject({})) =>
  ({ label: 'x.y', description: 'x.z', dependsOn, limits }) satisfies FeatureDefinition;

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
    expect(featureRegistryProblems({ a: def(['b']) })).toEqual(['a: unknown dependency b']);
  });

  it('reports cycles, including self-dependencies', () => {
    expect(featureRegistryProblems({ a: def(['a']) })).toEqual(['dependency cycle: a → a']);
    expect(featureRegistryProblems({ a: def(['b']), b: def(['c']), c: def(['a']) })).toEqual([
      'dependency cycle: a → b → c → a',
    ]);
  });

  it('accepts shared dependencies that are not cycles', () => {
    expect(featureRegistryProblems({ a: def(), b: def(['a']), c: def(['a', 'b']) })).toEqual([]);
  });

  it('reports bad keys and limits schemas', () => {
    expect(
      featureRegistryProblems({
        'Bad-Key': def(),
        loose: def([], z.object({ n: z.number().optional() })),
        required: def([], z.strictObject({ n: z.number() })),
      }),
    ).toEqual([
      'Bad-Key: key must match /^[a-z]+(\\.[a-z_]+)*$/',
      'loose: limits schema must be strict',
      'required: every limit must be optional',
    ]);
  });
});

describe('plans', () => {
  it('uses plan keys of the SQL shape with a label key', () => {
    for (const key of PLAN_KEYS) expect(key).toMatch(PLAN_KEY_PATTERN);
    expect(planLabel('inventory_billing')).toBe('platform.plans.inventoryBilling');
  });
});
