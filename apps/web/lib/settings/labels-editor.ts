import {
  dictionaries,
  isLabelKey,
  isLocale,
  isOrgOverridable,
  type LabelKey,
  type Locale,
  LOCALES,
  PLACEHOLDER,
  type Translator,
  validateOverride,
} from '@durby/i18n';
import type { LabelOverride } from '@durby/shared';

/**
 * The labels editor's rules (docs/platform/web-shell.md → Labels editor): which keys it offers,
 * the inline check of a value, the live preview and why a stored row is inactive.
 */

/** Keys organizations may override (terminology only), sorted, grouped by their module. */
export function overridableKeys(): { module: string; keys: LabelKey[] }[] {
  const keys = (Object.keys(dictionaries.en) as LabelKey[]).filter(isOrgOverridable).sort();
  const groups = new Map<string, LabelKey[]>();
  for (const key of keys) {
    const owner = key.split('.')[0] ?? '';
    groups.set(owner, [...(groups.get(owner) ?? []), key]);
  }
  return [...groups].map(([module, list]) => ({ module, keys: list }));
}

/**
 * Heading of a module's group: the module's own nav title (so the organization's terminology
 * applies), or "General" for platform keys and modules without one.
 */
export function moduleLabel(module: string): LabelKey {
  const title = `${module}.nav.title`;
  return module !== 'platform' && isLabelKey(title) ? title : 'platform.labelsEditor.general';
}

/**
 * The problem with `value` as an organization override of `key` in `locale`, as text, or null.
 * The same check the api runs (validateOverride); shown inline while typing.
 */
export function overrideProblem(
  t: Translator,
  key: LabelKey,
  locale: Locale,
  value: string,
): string | null {
  const check = validateOverride(key, locale, value, 'organization');
  if (check.ok) return null;
  switch (check.reason) {
    case 'blank':
      return t('platform.labelsEditor.problems.blank');
    case 'too_long':
      return t('platform.labelsEditor.problems.tooLong');
    case 'line_break':
      return t('platform.labelsEditor.problems.lineBreak');
    case 'control_character':
      return t('platform.labelsEditor.problems.controlCharacter');
    case 'braces':
      return t('platform.labelsEditor.problems.braces');
    case 'placeholders': {
      const list = (names: string[]) =>
        names.length === 0
          ? t('platform.labelsEditor.problems.none')
          : names.map((n) => `{${n}}`).join(', ');
      return t('platform.labelsEditor.problems.placeholders', {
        expected: list(check.expected),
        found: list(check.found),
      });
    }
  }
}

/** The text as it would render: placeholders shown as sample markers, e.g. `{count}` → `‹count›`. */
export function previewText(value: string): string {
  return value.replace(PLACEHOLDER, (_, name: string) => `‹${name}›`);
}

export type InactiveReason = 'removed' | 'notOverridable' | 'invalid';

/** Why a stored row has `active: false` (it is skipped on read and should be removed). */
export function inactiveReason(row: LabelOverride): InactiveReason {
  if (row.defaultValue === null || !isLocale(row.locale) || !isLabelKey(row.key)) return 'removed';
  if (!isOrgOverridable(row.key)) return 'notOverridable';
  return 'invalid';
}

export const EDITOR_LOCALES = LOCALES;
