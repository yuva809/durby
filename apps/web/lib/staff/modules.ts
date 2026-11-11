import type {
  CatalogFeature,
  CustomerEntitlements,
  FeatureCatalogResponse,
  FeatureKey,
  PlanKey,
} from '@durby/shared';

/**
 * Module switches of the staff portal (docs/platform/admin-portal.md → Modules, step 1d). Pure
 * state over the feature catalog the api serves: no module names here, so a new module needs no
 * portal change.
 */

/** Switched on or off, per feature key (the "own" state: plan or override, before dependencies). */
export type SwitchState = Partial<Record<FeatureKey, boolean>>;

/** Every feature of the catalog, modules first within their group, in catalog order. */
export function catalogFeatures(catalog: FeatureCatalogResponse): CatalogFeature[] {
  return catalog.modules.flatMap((m) => [m, ...m.features]);
}

/** The keys of one module card: the module and its sub-features. */
export function moduleKeys(catalog: FeatureCatalogResponse, module: FeatureKey): FeatureKey[] {
  const m = catalog.modules.find((x) => x.key === module);
  return m ? [m.key, ...m.features.map((f) => f.key)] : [];
}

/** What `plan` switches on. */
export function planState(catalog: FeatureCatalogResponse, plan: PlanKey): SwitchState {
  const included = new Set(catalog.plans.find((p) => p.key === plan)?.features ?? []);
  return Object.fromEntries(catalogFeatures(catalog).map((f) => [f.key, included.has(f.key)]));
}

/** A customer's switches as they are: an active override, else the plan. */
export function currentState(entitlements: CustomerEntitlements): SwitchState {
  return Object.fromEntries(
    entitlements.features.map((f) => [
      f.key,
      f.override && !f.override.expired ? f.override.enabled : f.inPlan,
    ]),
  );
}

function dependsOnMap(catalog: FeatureCatalogResponse): Map<FeatureKey, readonly FeatureKey[]> {
  return new Map(catalogFeatures(catalog).map((f) => [f.key, f.dependsOn]));
}

/** Every key `key` needs, transitively. */
export function dependenciesOf(catalog: FeatureCatalogResponse, key: FeatureKey): FeatureKey[] {
  const deps = dependsOnMap(catalog);
  const found = new Set<FeatureKey>();
  const visit = (k: FeatureKey) => {
    for (const d of deps.get(k) ?? []) {
      if (!found.has(d)) {
        found.add(d);
        visit(d);
      }
    }
  };
  visit(key);
  return catalogFeatures(catalog)
    .map((f) => f.key)
    .filter((k) => found.has(k));
}

/** Every key that needs `key`, transitively. */
export function dependentsOf(catalog: FeatureCatalogResponse, key: FeatureKey): FeatureKey[] {
  return catalogFeatures(catalog)
    .map((f) => f.key)
    .filter((k) => dependenciesOf(catalog, k).includes(key));
}

export interface Toggled {
  state: SwitchState;
  /** Switched on too, because `key` needs them. */
  alsoOn: FeatureKey[];
  /** Switched off too, because they need `key`. */
  alsoOff: FeatureKey[];
}

/**
 * Switches `key`: on also switches on what it needs (a sub-feature ticks its module); off also
 * switches off what needs it (a module unticks its sub-features), so the result never has a gap.
 */
export function applyToggle(
  catalog: FeatureCatalogResponse,
  state: SwitchState,
  key: FeatureKey,
  on: boolean,
): Toggled {
  const next: SwitchState = { ...state, [key]: on };
  const related = on ? dependenciesOf(catalog, key) : dependentsOf(catalog, key);
  const changed = related.filter((k) => (state[k] ?? false) !== on);
  for (const k of changed) next[k] = on;
  return { state: next, alsoOn: on ? changed : [], alsoOff: on ? [] : changed };
}

/** Sets a module card back to the plan, keeping the rest without a gap. */
export function resetModule(
  catalog: FeatureCatalogResponse,
  state: SwitchState,
  plan: SwitchState,
  module: FeatureKey,
): Toggled {
  let result: Toggled = { state, alsoOn: [], alsoOff: [] };
  for (const key of moduleKeys(catalog, module)) {
    const t = applyToggle(catalog, result.state, key, plan[key] ?? false);
    result = {
      state: t.state,
      alsoOn: [...result.alsoOn, ...t.alsoOn],
      alsoOff: [...result.alsoOff, ...t.alsoOff],
    };
  }
  const own = new Set(moduleKeys(catalog, module));
  return {
    state: result.state,
    alsoOn: [...new Set(result.alsoOn)].filter((k) => !own.has(k)),
    alsoOff: [...new Set(result.alsoOff)].filter((k) => !own.has(k)),
  };
}

/** The keys whose switch differs from the plan (onboarding sends these). */
export function differencesFromPlan(state: SwitchState, plan: SwitchState): SwitchState {
  return Object.fromEntries(
    (Object.keys(state) as FeatureKey[])
      .filter((k) => (state[k] ?? false) !== (plan[k] ?? false))
      .map((k) => [k, state[k] ?? false]),
  );
}

export type ModuleChange =
  | { key: FeatureKey; action: 'on' | 'off' }
  /** Back to the plan: the override goes. */
  | { key: FeatureKey; action: 'reset' };

/**
 * The api calls that turn the customer's switches into `desired`, in a safe order: everything that
 * ends off first (dependents before what they need), then everything that ends on (what is needed
 * before what needs it), so no call meets a missing dependency. Equal to the plan with an override
 * means a reset (no "custom" switch that only repeats the plan). `resets`: keys staff set back to the
 * plan ("Reset to plan"), whose override goes even when it already matches the plan.
 */
export function changesFor(
  catalog: FeatureCatalogResponse,
  entitlements: CustomerEntitlements,
  desired: SwitchState,
  resets: ReadonlySet<FeatureKey> = new Set(),
): ModuleChange[] {
  const current = currentState(entitlements);
  const byKey = new Map(entitlements.features.map((f) => [f.key, f]));
  const depth = (k: FeatureKey) => dependenciesOf(catalog, k).length;
  const changes: (ModuleChange & { ends: boolean })[] = [];
  for (const f of catalogFeatures(catalog)) {
    const row = byKey.get(f.key);
    if (!row) continue;
    const want = desired[f.key] ?? false;
    const activeOverride = row.override !== null && !row.override.expired;
    if (want === current[f.key]) {
      if (resets.has(f.key) && activeOverride && want === row.inPlan) {
        changes.push({ key: f.key, action: 'reset', ends: want });
      }
      continue;
    }
    if (want === row.inPlan && activeOverride) {
      changes.push({ key: f.key, action: 'reset', ends: want });
    } else {
      changes.push({ key: f.key, action: want ? 'on' : 'off', ends: want });
    }
  }
  const off = changes.filter((c) => !c.ends).sort((a, b) => depth(b.key) - depth(a.key));
  const on = changes.filter((c) => c.ends).sort((a, b) => depth(a.key) - depth(b.key));
  return [...off, ...on].map(({ key, action }) => ({ key, action }));
}

/**
 * What a change to `plan` switches on and off, in catalog order: every key without a kept override
 * follows the new plan (`resets` lose theirs with the change).
 */
export function planChangeEffect(
  catalog: FeatureCatalogResponse,
  entitlements: CustomerEntitlements,
  plan: PlanKey,
  resets: readonly FeatureKey[] = [],
): { on: FeatureKey[]; off: FeatureKey[] } {
  const before = currentState(entitlements);
  const next = planState(catalog, plan);
  const kept = new Map(
    keptOverrides(catalog, entitlements)
      .filter((o) => !resets.includes(o.key))
      .map((o) => [o.key, o.enabled]),
  );
  const effect = { on: [] as FeatureKey[], off: [] as FeatureKey[] };
  for (const { key } of catalogFeatures(catalog)) {
    const after = kept.get(key) ?? next[key] ?? false;
    if (after !== (before[key] ?? false)) (after ? effect.on : effect.off).push(key);
  }
  return effect;
}

/** Overrides that a plan change keeps (they stay whatever the new plan says), in catalog order. */
export function keptOverrides(
  catalog: FeatureCatalogResponse,
  entitlements: CustomerEntitlements,
): { key: FeatureKey; enabled: boolean; expiresOn: string | null }[] {
  const byKey = new Map(entitlements.features.map((f) => [f.key, f]));
  return catalogFeatures(catalog).flatMap(({ key }) => {
    const o = byKey.get(key)?.override;
    return o && !o.expired ? [{ key, enabled: o.enabled, expiresOn: o.expiresOn }] : [];
  });
}
