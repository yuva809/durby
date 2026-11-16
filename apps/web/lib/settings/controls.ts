import { isLabelKey, type LabelKey } from '@durby/i18n';
import {
  billFooterSchema,
  billHeaderSchema,
  billTextSchema,
  closedDatesSchema,
  posPrintersSchema,
  type ResolvedSetting,
  SETTING_KEYS,
  type SettingKey,
  settingAllowsScope,
  settingLabelBase,
  SETTINGS,
  ticketTextSchema,
  turnTimesSchema,
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
  /** `numeric`: the options are numbers (a literal union); the value is sent as a number. */
  | { kind: 'select'; options: SettingOption[]; numeric?: true }
  | { kind: 'boolean' }
  | { kind: 'text' }
  /** Windows per weekday (`openingHours`). */
  | { kind: 'weeklyHours' }
  /** A set of calendar days (`closedDates`). */
  | { kind: 'dateList' }
  /** A whole number in [min, max]. */
  | { kind: 'number'; min: number; max: number }
  /** A whole number in [min, max], or the literal `off` ("no limit"). */
  | { kind: 'limit'; off: string; min: number; max: number }
  /** The literal `inherit` (another setting's schedule), or a weekly schedule of its own. */
  | { kind: 'scheduleOr'; inherit: string }
  /** Party-size bands with minutes (`reservations.turnTimes`). */
  | { kind: 'turnTimes' }
  /** Edited on a page of its own (the bill's header, footer and text sizes with a preview; the printers). */
  | { kind: 'page'; href: string };

/** `weighted_average` → `weightedAverage` (label keys are camelCase). */
const camel = (value: string) =>
  value.replace(/[_-]([a-z0-9])/g, (_, c: string) => c.toUpperCase());

interface SchemaShape {
  def: { type: string; values?: readonly unknown[]; options?: readonly SchemaShape[] };
  options?: readonly unknown[];
  minValue?: number | null;
  maxValue?: number | null;
}

const bounds = (schema: SchemaShape) => ({
  min: schema.minValue ?? 0,
  max: schema.maxValue ?? Number.MAX_SAFE_INTEGER,
});

/** The control for `key`, or null if its schema is of a kind no control covers yet. */
export function controlOf(key: SettingKey): SettingControl | null {
  if (SETTINGS[key].schema === weeklyHoursSchema) return { kind: 'weeklyHours' };
  if (SETTINGS[key].schema === closedDatesSchema) return { kind: 'dateList' };
  if (SETTINGS[key].schema === turnTimesSchema) return { kind: 'turnTimes' };
  // The bill page: header, footer and text sizes, with a live preview.
  if (
    [billHeaderSchema, billFooterSchema, billTextSchema, ticketTextSchema].includes(
      SETTINGS[key].schema as never,
    )
  ) {
    return { kind: 'page', href: '/settings/bill' };
  }
  // Printers per location, with Find printer and a test print through the Android app (ADR 0032).
  if (SETTINGS[key].schema === posPrintersSchema)
    return { kind: 'page', href: '/settings/printers' };
  const schema = SETTINGS[key].schema as unknown as SchemaShape;
  switch (schema.def.type) {
    case 'literal': {
      const values = schema.def.values ?? [];
      return {
        kind: 'select',
        ...(values.every((v) => typeof v === 'number') ? { numeric: true as const } : {}),
        options: values.map((value) => {
          // Label key segments start with a letter: 15 → `v15`.
          const segment = typeof value === 'number' ? `v${value}` : camel(String(value));
          const label = `${settingLabelBase(key)}.options.${segment}`;
          return { value: String(value), label: isLabelKey(label) ? label : null };
        }),
      };
    }
    case 'number':
      return { kind: 'number', ...bounds(schema) };
    case 'union': {
      // 'off' | number → a limit; 'openingHours' | schedule → a schedule or the inherited one.
      const [word, other] = schema.def.options ?? [];
      const literal = word?.def.type === 'literal' ? String(word.def.values?.[0]) : null;
      if (literal === null || !other) return null;
      if (other.def.type === 'number') return { kind: 'limit', off: literal, ...bounds(other) };
      if ((other as unknown) === weeklyHoursSchema) return { kind: 'scheduleOr', inherit: literal };
      return null;
    }
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

/**
 * "Set here" for a value stored at the page's own level (`scope`: the organization on the General
 * tab, a location on Settings → Reservations); anything else is inherited.
 */
export const isSetHere = (
  setting: Pick<ResolvedSetting, 'source'>,
  scope: 'organization' | 'location' = 'organization',
): boolean => setting.source === scope;
