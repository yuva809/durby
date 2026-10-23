import {
  type Dictionary,
  dictionaries,
  isLabelKey,
  isLocale,
  isOrgOverridable,
  type LabelKey,
  type LabelOverrideLevel,
  type Locale,
  validateOverride,
} from '@durby/i18n';

/** A stored override (`partner_label_overrides` or `label_overrides`). */
export interface LabelOverrideRow {
  locale: string;
  key: string;
  value: string;
}

/** The stored overrides of one organization and its partner, every locale. */
export interface LabelRows {
  partner: readonly LabelOverrideRow[];
  organization: readonly LabelOverrideRow[];
}

/** Why a stored row is skipped on read. */
export type SkipReason =
  | 'unknown_locale'
  | 'unknown_key'
  | 'not_overridable'
  | 'blank'
  | 'too_long'
  | 'line_break'
  | 'control_character'
  | 'braces'
  | 'placeholders';

export interface SkippedOverride {
  level: LabelOverrideLevel;
  locale: string;
  key: string;
  reason: SkipReason;
}

/**
 * Why a stored row at `level` may not be used, or null if it may (docs/platform/labels.md →
 * Resolution). Organization rows must also be org-overridable and within the organization limits.
 */
export function skipReason(row: LabelOverrideRow, level: LabelOverrideLevel): SkipReason | null {
  if (!isLocale(row.locale)) return 'unknown_locale';
  if (!isLabelKey(row.key)) return 'unknown_key';
  if (level === 'organization' && !isOrgOverridable(row.key)) return 'not_overridable';
  const check = validateOverride(row.key, row.locale, row.value, level);
  return check.ok ? null : check.reason;
}

/**
 * The merged overrides of `locale`: organization over partner, rows of other locales never used
 * (ADR 0011 §5). Rows that may not be used are skipped and reported through `onSkipped` (fail
 * safe: the next level applies).
 */
export function resolveOverrides(
  rows: LabelRows,
  locale: Locale,
  onSkipped: (skipped: SkippedOverride) => void = () => undefined,
): Partial<Record<LabelKey, string>> {
  const merged: Partial<Record<LabelKey, string>> = {};
  for (const level of ['partner', 'organization'] as const) {
    for (const row of rows[level]) {
      if (row.locale !== locale) continue;
      const reason = skipReason(row, level);
      if (reason) onSkipped({ level, locale: row.locale, key: row.key, reason });
      else merged[row.key as LabelKey] = row.value;
    }
  }
  return merged;
}

/**
 * Every label key resolved for `locale`: organization override → partner override → default
 * (locale) → default (`en`) → the key itself.
 */
export function resolveDictionary(
  rows: LabelRows,
  locale: Locale,
  onSkipped?: (skipped: SkippedOverride) => void,
): Dictionary {
  const overrides = resolveOverrides(rows, locale, onSkipped);
  const defaults = dictionaries[locale];
  const fallback = dictionaries.en;
  const resolved = {} as Dictionary;
  for (const key of Object.keys(fallback) as LabelKey[]) {
    resolved[key] = overrides[key] ?? defaults[key] ?? fallback[key] ?? key;
  }
  return resolved;
}
