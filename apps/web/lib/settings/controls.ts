import { isLabelKey, type LabelKey } from '@durby/i18n';
import {
  closedDatesSchema,
  type ResolvedSetting,
  SETTING_KEYS,
  type SettingKey,
  settingAllowsScope,
  settingLabelBase,
  SETTINGS,
  weeklyHoursSchema,
} from '@durby/shared';

/**
 * Form controls generated from the settings registry (docs/platform/web-shell.md → Settings):
 * each key's control follows its schema, so a new key needs no page code unless its schema is a
 * new kind (a test fails then).
 */

export interface SettingOption {
  value: string;
  /** `platform.settings.<key>.options.<camelCaseValue>` when it exists; else the value is shown. */
  label: LabelKey | null;
}

export type SettingControl =
  | { kind: 'select'; options: SettingOption[] }
  | { kind: 'boolean' }
  | { kind: 'text' }
  /** Windows per weekday (`openingHours`). */
  | { kind: 'weeklyHours' }
  /** A set of calendar days (`closedDates`). */
  | { kind: 'dateList' };

/** `weighted_average` → `weightedAverage` (label keys are camelCase). */
const camel = (value: string) =>
  value.replace(/[_-]([a-z0-9])/g, (_, c: string) => c.toUpperCase());

interface SchemaShape {
  def: { type: string };
  options?: readonly unknown[];
}

/** The control for `key`, or null if its schema is of a kind no control covers yet. */
export function controlOf(key: SettingKey): SettingControl | null {
  if (SETTINGS[key].schema === weeklyHoursSchema) return { kind: 'weeklyHours' };
  if (SETTINGS[key].schema === closedDatesSchema) return { kind: 'dateList' };
  const schema = SETTINGS[key].schema as unknown as SchemaShape;
  switch (schema.def.type) {
    case 'enum':
      return {
        kind: 'select',
        options: (schema.options ?? []).map((value) => {
          const label = `${settingLabelBase(key)}.options.${camel(String(value))}`;
          return { value: String(value), label: isLabelKey(label) ? label : null };
        }),
      };
    case 'boolean':
      return { kind: 'boolean' };
    case 'string':
      return { kind: 'text' };
    default:
      return null;
  }
}

/** Keys this page edits: those that may be stored at organization scope, in registry order. */
export const ORGANIZATION_SETTING_KEYS: readonly SettingKey[] = SETTING_KEYS.filter((key) =>
  settingAllowsScope(key, 'organization'),
);

export const settingLabels = (key: SettingKey) => ({
  name: SETTINGS[key].label as LabelKey,
  description: SETTINGS[key].description as LabelKey,
});

/** Whether `value` passes the key's own schema (checked before sending; the api checks again). */
export function isValidSettingValue(key: SettingKey, value: unknown): boolean {
  return SETTINGS[key].schema.safeParse(value).success;
}

/**
 * The registry's code defaults in the shape of `GET /settings`: what the page shows when the call
 * is denied (403) or fails (settings.md → Web app).
 */
export function codeDefaults(): ResolvedSetting[] {
  return SETTING_KEYS.map((key) => ({
    key,
    value: SETTINGS[key].default,
    source: 'default',
    dataBound: SETTINGS[key].dataBound,
  }));
}

/** "Set here" for an organization value; anything else is inherited (partner or default). */
export const isSetHere = (setting: Pick<ResolvedSetting, 'source'>): boolean =>
  setting.source === 'organization';
