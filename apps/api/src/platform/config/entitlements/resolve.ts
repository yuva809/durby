import { FEATURE_KEYS, FEATURES, type FeatureKey, featureLimitNames } from '@durby/shared';
import type { z } from 'zod';

/** The stored rows of one organization, as loaded by EntitlementService. */
export interface EntitlementRows {
  /** null: the organization has no plan (nothing from a plan is enabled). */
  plan: {
    key: string;
    features: readonly { featureKey: string; limits: unknown }[];
  } | null;
  overrides: readonly { featureKey: string; enabled: boolean; limits: unknown }[];
}

/** Every limit name of the feature's schema; null = unlimited. */
export type ResolvedLimits = Readonly<Record<string, number | null>>;

export interface ResolvedEntitlements {
  planKey: string | null;
  /** Enabled features only, in registry order. */
  features: ReadonlyMap<FeatureKey, ResolvedLimits>;
}

export const NO_ENTITLEMENTS: ResolvedEntitlements = Object.freeze({
  planKey: null,
  features: new Map<FeatureKey, ResolvedLimits>(),
});

/**
 * Resolves an organization's entitlements (docs/platform/entitlements.md → Resolution):
 * own state override → plan → disabled; enabled only if every dependency is enabled
 * (transitively); limits per name override → plan → unlimited. Stored keys that aren't registered
 * and stored limits that don't match the feature's schema are ignored (fail closed) and reported
 * through `onIgnored`.
 */
export function resolveEntitlements(
  rows: EntitlementRows,
  onIgnored: (problem: string) => void = () => undefined,
): ResolvedEntitlements {
  const planRows = new Map<string, unknown>();
  for (const row of rows.plan?.features ?? []) planRows.set(row.featureKey, row.limits);
  const overrides = new Map<string, { enabled: boolean; limits: unknown }>();
  for (const row of rows.overrides) overrides.set(row.featureKey, row);
  for (const key of [...planRows.keys(), ...overrides.keys()]) {
    if (!Object.hasOwn(FEATURES, key)) onIgnored(`unregistered feature key ${key}`);
  }

  const own = (key: FeatureKey): boolean => overrides.get(key)?.enabled ?? planRows.has(key);
  const memo = new Map<FeatureKey, boolean>();
  // The registry is acyclic (tested in packages/shared), so the recursion ends.
  const enabled = (key: FeatureKey): boolean => {
    let result = memo.get(key);
    if (result === undefined) {
      result = own(key) && FEATURES[key].dependsOn.every((dep) => enabled(dep as FeatureKey));
      memo.set(key, result);
    }
    return result;
  };

  const features = new Map<FeatureKey, ResolvedLimits>();
  for (const key of FEATURE_KEYS) {
    if (!enabled(key)) continue;
    const fromPlan = limitsOf(key, planRows.get(key), 'plan', onIgnored);
    const fromOverride = limitsOf(key, overrides.get(key)?.limits, 'override', onIgnored);
    const limits: Record<string, number | null> = {};
    for (const name of featureLimitNames(key)) {
      limits[name] = fromOverride[name] ?? fromPlan[name] ?? null;
    }
    features.set(key, Object.freeze(limits));
  }
  return { planKey: rows.plan?.key ?? null, features };
}

/** The valid limits of a stored jsonb value, per name; invalid or unknown names are dropped. */
function limitsOf(
  key: FeatureKey,
  stored: unknown,
  source: 'plan' | 'override',
  onIgnored: (problem: string) => void,
): Partial<Record<string, number>> {
  if (stored === null || stored === undefined) return {};
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    onIgnored(`${source} limits of ${key} are not an object`);
    return {};
  }
  const shape = (FEATURES[key].limits as z.ZodObject).shape as Record<string, z.ZodType>;
  const out: Partial<Record<string, number>> = {};
  for (const [name, value] of Object.entries(stored)) {
    const schema = shape[name];
    const parsed = schema?.safeParse(value);
    if (parsed?.success && typeof parsed.data === 'number') out[name] = parsed.data;
    else onIgnored(`${source} limit ${key}.${name} is ${schema ? 'invalid' : 'unregistered'}`);
  }
  return out;
}
