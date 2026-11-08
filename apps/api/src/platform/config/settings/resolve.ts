import {
  SETTING_KEYS,
  SETTINGS,
  type SettingKey,
  type SettingScope,
  type SettingSource,
  settingAllowsScope,
  type TenantSettingScope,
} from '@durby/shared';

/** A row of `setting_values`, as loaded by SettingsService. */
export interface TenantSettingRow {
  scopeType: TenantSettingScope;
  brandId: string | null;
  locationId: string | null;
  key: string;
  value: unknown;
}

/** The stored values of one organization and its partner. */
export interface SettingRows {
  partner: readonly { key: string; value: unknown }[];
  tenant: readonly TenantSettingRow[];
}

/** Where to resolve: organization (both null), a brand, or a location and its brand. */
export interface SettingTarget {
  brandId: string | null;
  locationId: string | null;
}

export interface ResolvedSettingValue {
  value: unknown;
  source: SettingSource;
}

/** Every registered key, in registry order. */
export type ResolvedSettings = ReadonlyMap<SettingKey, ResolvedSettingValue>;

/**
 * Resolves settings at `target` (docs/platform/settings.md → Resolution): location → brand →
 * organization → partner → code default; the first level with a valid value wins. Values that fail
 * the key's schema, values at a scope the key doesn't allow and unregistered keys are skipped (fail
 * safe: the next level applies) and reported through `onIgnored`.
 */
export function resolveSettings(
  rows: SettingRows,
  target: SettingTarget,
  onIgnored: (problem: string) => void = () => undefined,
): ResolvedSettings {
  const stored = new Map<string, Partial<Record<SettingScope, unknown>>>();
  const put = (key: string, scope: SettingScope, value: unknown) => {
    if (!Object.hasOwn(SETTINGS, key)) {
      onIgnored(`unregistered setting key ${key}`);
      return;
    }
    const levels = stored.get(key) ?? {};
    levels[scope] = value;
    stored.set(key, levels);
  };
  for (const row of rows.partner) put(row.key, 'partner', row.value);
  for (const row of rows.tenant) {
    if (row.scopeType === 'organization') put(row.key, 'organization', row.value);
    else if (row.scopeType === 'brand' && target.brandId !== null && row.brandId === target.brandId)
      put(row.key, 'brand', row.value);
    else if (
      row.scopeType === 'location' &&
      target.locationId !== null &&
      row.locationId === target.locationId
    )
      put(row.key, 'location', row.value);
  }

  const resolved = new Map<SettingKey, ResolvedSettingValue>();
  for (const key of SETTING_KEYS) {
    const levels = stored.get(key) ?? {};
    let result: ResolvedSettingValue = { value: SETTINGS[key].default, source: 'default' };
    for (const scope of ['location', 'brand', 'organization', 'partner'] as const) {
      if (!Object.hasOwn(levels, scope)) continue;
      if (!settingAllowsScope(key, scope)) {
        onIgnored(`${key} is not allowed at ${scope} scope`);
        continue;
      }
      // Forward-compatible where the key has a read schema: a later release's additions are dropped (ADR 0033).
      const def = SETTINGS[key];
      const parsed = (def.read ?? def.schema).safeParse(levels[scope]);
      if (!parsed.success) {
        onIgnored(`invalid ${scope} value of ${key}`);
        continue;
      }
      result = { value: parsed.data, source: scope };
      break;
    }
    resolved.set(key, result);
  }
  return resolved;
}
