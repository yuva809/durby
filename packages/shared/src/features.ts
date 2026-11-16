import { z } from 'zod';

/**
 * Feature key registry (`module.capability`). See docs/platform/entitlements.md and ADR 0009.
 *
 * Adding a key: its `module` and `order`, a name and a description label (defaults in every locale
 * of packages/i18n), the keys it depends on, and a strict limits schema (`noLimits` if it has none).
 * A test fails on unknown dependencies, cycles, non-strict schemas, a bad module group or missing
 * labels. Plans get the key in a migration. The staff portal shows it with no code change
 * (docs/platform/entitlements.md → Adding a new module).
 */
export interface FeatureDefinition {
  /**
   * The module this key belongs to (admin portal 1d): a registered key whose `module` is itself.
   * A module key (`inventory`) names itself; a sub-feature (`inventory.counts`) names its module
   * and depends on it. The staff portal groups and sorts its switches by `module` and `order`.
   */
  module: string;
  /** Sort order among the modules (for a module key) or within its module (for a sub-feature). */
  order: number;
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
    module: 'inventory',
    order: 30,
    label: 'platform.features.inventory.name',
    description: 'platform.features.inventory.description',
    dependsOn: [],
    limits: z.strictObject({ maxLocations: positiveInt.optional() }),
  },
  'inventory.counts': {
    module: 'inventory',
    order: 1,
    label: 'platform.features.inventoryCounts.name',
    description: 'platform.features.inventoryCounts.description',
    dependsOn: ['inventory'],
    limits: noLimits,
  },
  'inventory.purchasing': {
    module: 'inventory',
    order: 2,
    label: 'platform.features.inventoryPurchasing.name',
    description: 'platform.features.inventoryPurchasing.description',
    dependsOn: ['inventory'],
    limits: noLimits,
  },
  // Sales orders, picking and delivery tracking for distribution (ADR 0044): sells stock items.
  orders: {
    module: 'orders',
    order: 35,
    label: 'platform.features.orders.name',
    description: 'platform.features.orders.description',
    dependsOn: ['inventory'],
    limits: noLimits,
  },
  billing: {
    module: 'billing',
    order: 50,
    label: 'platform.features.billing.name',
    description: 'platform.features.billing.description',
    dependsOn: [],
    limits: noLimits,
  },
  'billing.einvoice': {
    module: 'billing',
    order: 1,
    label: 'platform.features.billingEinvoice.name',
    description: 'platform.features.billingEinvoice.description',
    dependsOn: ['billing'],
    limits: noLimits,
  },
  pos: {
    module: 'pos',
    order: 20,
    label: 'platform.features.pos.name',
    description: 'platform.features.pos.description',
    // Orders, the floor and the screens sell catalog products (admin portal 1d).
    dependsOn: ['catalog'],
    limits: noLimits,
  },
  'pos.fiscal': {
    module: 'pos',
    order: 1,
    label: 'platform.features.posFiscal.name',
    description: 'platform.features.posFiscal.description',
    dependsOn: ['pos'],
    limits: noLimits,
  },
  reports: {
    module: 'reports',
    order: 60,
    label: 'platform.features.reports.name',
    description: 'platform.features.reports.description',
    dependsOn: [],
    limits: noLimits,
  },
  'api.public': {
    module: 'api.public',
    order: 70,
    label: 'platform.features.apiPublic.name',
    description: 'platform.features.apiPublic.description',
    dependsOn: [],
    limits: z.strictObject({ requestsPerMinute: positiveInt.optional() }),
  },
  whitelabel: {
    module: 'whitelabel',
    order: 80,
    label: 'platform.features.whitelabel.name',
    description: 'platform.features.whitelabel.description',
    dependsOn: [],
    limits: noLimits,
  },
  catalog: {
    module: 'catalog',
    order: 10,
    label: 'platform.features.catalog.name',
    description: 'platform.features.catalog.description',
    dependsOn: [],
    limits: noLimits,
  },
  // docs/modules/reservations.md → Features: bookings, the host stand and setup need pos tables.
  reservations: {
    module: 'reservations',
    order: 40,
    label: 'platform.features.reservations.name',
    description: 'platform.features.reservations.description',
    dependsOn: ['pos'],
    limits: noLimits,
  },
  // The public booking page, holds, guest mails and self-cancel (R2).
  'reservations.online': {
    module: 'reservations',
    order: 1,
    label: 'platform.features.reservationsOnline.name',
    description: 'platform.features.reservationsOnline.description',
    dependsOn: ['reservations'],
    limits: noLimits,
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURES;

/** Registry order: used for every list of features the api returns. */
export const FEATURE_KEYS = Object.keys(FEATURES) as readonly FeatureKey[];

/** Module keys (their `module` is themselves), sorted by `order`: the portal's module cards. */
export const FEATURE_MODULES: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (key) => FEATURES[key].module === key,
).sort((a, b) => FEATURES[a].order - FEATURES[b].order);

/** The sub-features of a module, sorted by `order` (the module key itself excluded). */
export function featuresOfModule(module: FeatureKey): FeatureKey[] {
  return FEATURE_KEYS.filter((key) => key !== module && FEATURES[key].module === module).sort(
    (a, b) => FEATURES[a].order - FEATURES[b].order,
  );
}

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
    if (!Number.isInteger(def.order) || def.order < 0)
      problems.push(`${key}: order must be a non-negative integer`);
    const root = registry[def.module];
    if (!root || root.module !== def.module) {
      problems.push(`${key}: module ${def.module} must be a registered module key`);
    } else if (def.module !== key && !dependsOnTransitively(registry, key, def.module)) {
      problems.push(`${key}: must depend on its module ${def.module}`);
    }
    if (!def.limits.safeParse({}).success) problems.push(`${key}: every limit must be optional`);
    else if (!isStrict(def.limits)) problems.push(`${key}: limits schema must be strict`);
  }
  // Siblings (the modules; the sub-features of one module) need distinct orders.
  const seen = new Map<string, string>();
  for (const key of keys) {
    const def = registry[key] as FeatureDefinition;
    const group = def.module === key ? '(modules)' : def.module;
    const slot = `${group}#${def.order}`;
    const other = seen.get(slot);
    if (other) problems.push(`${key}: order ${def.order} already used by ${other} in ${group}`);
    else seen.set(slot, key);
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

/** Whether `key` reaches `target` through dependsOn (cycle-safe). */
function dependsOnTransitively(
  registry: Readonly<Record<string, FeatureDefinition>>,
  key: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  const stack = [...(registry[key]?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(registry[next]?.dependsOn ?? []));
  }
  return false;
}

/** A strict object rejects unknown keys, so stored limits can't carry free-form fields. */
function isStrict(schema: z.ZodObject): boolean {
  return !schema.safeParse({ __unknown__: 1 }).success;
}
