import { z } from 'zod';

/**
 * Feature key registry (`module.capability`). See docs/platform/entitlements.md and ADR 0009.
 *
 * Adding a key: a name and a description label (`en` and `de` defaults in packages/i18n), the keys it
 * depends on, and a strict limits schema (`noLimits` if it has none). A test fails on unknown
 * dependencies, cycles, non-strict schemas or missing labels. Plans get the key in a migration.
 */
export interface FeatureDefinition {
  /** Label key of the feature's display name. */
  label: string;
  /** Label key of a one-line description. */
  description: string;
  /** Keys that must be enabled too, or this one counts as disabled. */
  dependsOn: readonly string[];
  /** Strict object of optional limits; an absent limit means unlimited. */
  limits: z.ZodObject;
}

const noLimits = z.strictObject({});
const positiveInt = z.int().positive();

export const FEATURES = {
  inventory: {
    label: 'platform.features.inventory.name',
    description: 'platform.features.inventory.description',
    dependsOn: [],
    limits: z.strictObject({ maxLocations: positiveInt.optional() }),
  },
  'inventory.counts': {
    label: 'platform.features.inventoryCounts.name',
    description: 'platform.features.inventoryCounts.description',
    dependsOn: ['inventory'],
    limits: noLimits,
  },
  'inventory.purchasing': {
    label: 'platform.features.inventoryPurchasing.name',
    description: 'platform.features.inventoryPurchasing.description',
    dependsOn: ['inventory'],
    limits: noLimits,
  },
  billing: {
    label: 'platform.features.billing.name',
    description: 'platform.features.billing.description',
    dependsOn: [],
    limits: noLimits,
  },
  'billing.einvoice': {
    label: 'platform.features.billingEinvoice.name',
    description: 'platform.features.billingEinvoice.description',
    dependsOn: ['billing'],
    limits: noLimits,
  },
  pos: {
    label: 'platform.features.pos.name',
    description: 'platform.features.pos.description',
    dependsOn: [],
    limits: noLimits,
  },
  'pos.fiscal': {
    label: 'platform.features.posFiscal.name',
    description: 'platform.features.posFiscal.description',
    dependsOn: ['pos'],
    limits: noLimits,
  },
  reports: {
    label: 'platform.features.reports.name',
    description: 'platform.features.reports.description',
    dependsOn: [],
    limits: noLimits,
  },
  'api.public': {
    label: 'platform.features.apiPublic.name',
    description: 'platform.features.apiPublic.description',
    dependsOn: [],
    limits: z.strictObject({ requestsPerMinute: positiveInt.optional() }),
  },
  whitelabel: {
    label: 'platform.features.whitelabel.name',
    description: 'platform.features.whitelabel.description',
    dependsOn: [],
    limits: noLimits,
  },
  catalog: {
    label: 'platform.features.catalog.name',
    description: 'platform.features.catalog.description',
    dependsOn: [],
    limits: noLimits,
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURES;

/** Registry order: used for every list of features the api returns. */
export const FEATURE_KEYS = Object.keys(FEATURES) as readonly FeatureKey[];

/** Limits of one feature, e.g. `{ maxLocations?: number }`. */
export type FeatureLimits<K extends FeatureKey> = z.infer<(typeof FEATURES)[K]['limits']>;

/** Limit names of one feature, e.g. `'maxLocations'`. */
export type FeatureLimitName<K extends FeatureKey> = keyof FeatureLimits<K> & string;

/** Same shape as the `*_feature_key_format_check` constraints. */
export const FEATURE_KEY_PATTERN = /^[a-z]+(\.[a-z_]+)*$/;

export function isFeatureKey(value: string): value is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, value);
}

/** The limit names a feature's schema declares, in schema order. */
export function featureLimitNames(key: FeatureKey): string[] {
  return Object.keys((FEATURES[key].limits as z.ZodObject).shape);
}

/**
 * Plans the migrations create (plan contents change only through migrations, ADR 0009). A migration
 * adding a plan adds its key here; display names are `platform.plans.<camelCaseKey>` labels.
 */
export const PLAN_KEYS = ['inventory', 'inventory_billing', 'full'] as const;

export type PlanKey = (typeof PLAN_KEYS)[number];

/** Same shape as `plans_key_format_check`. */
export const PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export function planLabel(key: string): string {
  return `platform.plans.${key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`;
}

/**
 * Problems of a feature registry: bad key shape, unknown dependencies, dependency cycles (also a
 * key depending on itself), required or non-strict limits. Empty for FEATURES (tested); takes any registry so the checks are
 * testable on broken ones.
 */
export function featureRegistryProblems(
  registry: Readonly<Record<string, FeatureDefinition>>,
): string[] {
  const problems: string[] = [];
  const keys = Object.keys(registry);
  for (const key of keys) {
    const def = registry[key] as FeatureDefinition;
    if (!FEATURE_KEY_PATTERN.test(key))
      problems.push(`${key}: key must match ${FEATURE_KEY_PATTERN}`);
    for (const dep of def.dependsOn) {
      if (!Object.hasOwn(registry, dep)) problems.push(`${key}: unknown dependency ${dep}`);
    }
    if (!def.limits.safeParse({}).success) problems.push(`${key}: every limit must be optional`);
    else if (!isStrict(def.limits)) problems.push(`${key}: limits schema must be strict`);
  }
  // Depth-first search; a key met again while still on the path closes a cycle.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string, path: string[]): void => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      problems.push(`dependency cycle: ${[...path.slice(path.indexOf(key)), key].join(' → ')}`);
      return;
    }
    state.set(key, 'visiting');
    for (const dep of registry[key]?.dependsOn ?? []) {
      if (Object.hasOwn(registry, dep)) visit(dep, [...path, key]);
    }
    state.set(key, 'done');
  };
  for (const key of keys) visit(key, []);
  return problems;
}

/** A strict object rejects unknown keys, so stored limits can't carry free-form fields. */
function isStrict(schema: z.ZodObject): boolean {
  return !schema.safeParse({ __unknown__: 1 }).success;
}
