import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { CURRENCY_CODES } from './currencies';
import { closedDatesSchema, DEFAULT_OPENING_HOURS, weeklyHoursSchema } from './time/opening-hours';

/**
 * Settings registry (`module.camelCaseName`; platform-wide keys have no module prefix). See
 * docs/platform/settings.md and ADR 0010.
 *
 * Adding a key: a name and a description label (`en` and `de` defaults in packages/i18n), a strict
 * schema, a default that passes it, the scopes it may be set at, and `dataBound`. Settings never
 * hold secrets: values are shown to members and copied into audit rows. A test fails on bad keys,
 * defaults, scopes, secret-looking names or missing labels.
 */

/** Most specific first: the resolution order (the code default comes last). */
export const SETTING_SCOPES = ['location', 'brand', 'organization', 'partner'] as const;

export type SettingScope = (typeof SETTING_SCOPES)[number];

/** Scopes stored in `setting_values` (partner values are platform data). */
export const TENANT_SETTING_SCOPES = ['organization', 'brand', 'location'] as const;

export type TenantSettingScope = (typeof TENANT_SETTING_SCOPES)[number];

/** Where a resolved value came from. */
export type SettingSource = SettingScope | 'default';

export const SETTING_SOURCES = [...SETTING_SCOPES, 'default'] as const;

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  /** Label key of the setting's display name. */
  label: string;
  /** Label key of a one-line description. */
  description: string;
  schema: S;
  default: z.infer<S>;
  /** The scopes a value may be stored at. */
  scopes: readonly SettingScope[];
  /**
   * Changing it reinterprets data recorded under it (amounts, stock value): allowed only while no
   * module reports data depending on it at that scope (docs/platform/settings.md → Data-bound).
   */
  dataBound: boolean;
}

const ALL_SCOPES = ['partner', 'organization', 'brand', 'location'] as const;

/** An IANA zone name, accepted by the runtime's time zone database (not offsets like `+01:00`). */
const timeZone = z
  .string()
  .regex(/^(UTC|[A-Z][A-Za-z_-]*(\/[A-Za-z0-9_+-]+)+)$/)
  .refine(isTimeZone, { message: 'Unknown time zone' });

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const define = <S extends z.ZodType>(def: SettingDefinition<S>): SettingDefinition<S> => def;

export const SETTINGS = {
  locale: define({
    label: 'platform.settings.locale.name',
    description: 'platform.settings.locale.description',
    schema: z.enum(LOCALES),
    default: 'en',
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  currency: define({
    label: 'platform.settings.currency.name',
    description: 'platform.settings.currency.description',
    schema: z.enum(CURRENCY_CODES),
    default: 'EUR',
    scopes: ['partner', 'organization'],
    dataBound: true,
  }),
  timezone: define({
    label: 'platform.settings.timezone.name',
    description: 'platform.settings.timezone.description',
    schema: timeZone,
    default: 'Europe/Berlin',
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  openingHours: define({
    label: 'platform.settings.openingHours.name',
    description: 'platform.settings.openingHours.description',
    schema: weeklyHoursSchema,
    default: DEFAULT_OPENING_HOURS,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  closedDates: define({
    label: 'platform.settings.closedDates.name',
    description: 'platform.settings.closedDates.description',
    schema: closedDatesSchema,
    default: [],
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'inventory.valuationMethod': define({
    label: 'platform.settings.inventoryValuationMethod.name',
    description: 'platform.settings.inventoryValuationMethod.description',
    schema: z.enum(['fifo', 'weighted_average']),
    default: 'weighted_average',
    scopes: ['partner', 'organization'],
    dataBound: true,
  }),
  'inventory.allowNegativeStock': define({
    label: 'platform.settings.inventoryAllowNegativeStock.name',
    description: 'platform.settings.inventoryAllowNegativeStock.description',
    schema: z.boolean(),
    default: false,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;

/** Registry order: used for every list of settings the api returns. */
export const SETTING_KEYS = Object.keys(SETTINGS) as readonly SettingKey[];

/** The value type of one setting, e.g. `'fifo' | 'weighted_average'`. */
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;

/** Same shape as the `*_key_format_check` constraints. */
export const SETTING_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

/** Key names that suggest a secret; settings never hold secrets (ADR 0010 §1). */
const SECRET_LIKE = /secret|password|token|apikey|credential|privatekey/i;

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, value);
}

/** Whether `key` may be stored at `scope`. */
export function settingAllowsScope(key: SettingKey, scope: SettingScope): boolean {
  return SETTINGS[key].scopes.includes(scope);
}

/** `inventory.valuationMethod` → `platform.settings.inventoryValuationMethod`. */
export function settingLabelBase(key: string): string {
  return `platform.settings.${key.replace(/\.([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

/**
 * Problems of a settings registry: bad key shape, labels not derived from the key, a default that
 * fails its schema, non-strict object schemas, unknown or no scopes, data-bound keys below
 * organization scope, secret-looking names. Empty for SETTINGS (tested); takes any registry so the
 * checks are testable on broken ones.
 */
export function settingRegistryProblems(
  registry: Readonly<Record<string, SettingDefinition>>,
): string[] {
  const problems: string[] = [];
  for (const [key, def] of Object.entries(registry)) {
    if (!SETTING_KEY_PATTERN.test(key)) {
      problems.push(`${key}: key must match ${SETTING_KEY_PATTERN}`);
    }
    if (SECRET_LIKE.test(key)) problems.push(`${key}: settings never hold secrets`);
    const base = settingLabelBase(key);
    if (def.label !== `${base}.name` || def.description !== `${base}.description`) {
      problems.push(`${key}: labels must be ${base}.name and ${base}.description`);
    }
    if (!def.schema.safeParse(def.default).success) {
      problems.push(`${key}: default fails the schema`);
    }
    // A strict object has a `never` catchall, so stored values can't carry free-form fields.
    if (def.schema instanceof z.ZodObject && !(def.schema.def.catchall instanceof z.ZodNever)) {
      problems.push(`${key}: object schema must be strict`);
    }
    if (def.scopes.length === 0) problems.push(`${key}: needs at least one scope`);
    for (const scope of def.scopes) {
      if (!(SETTING_SCOPES as readonly string[]).includes(scope)) {
        problems.push(`${key}: unknown scope ${scope}`);
      }
    }
    if (def.dataBound && def.scopes.some((s) => s === 'brand' || s === 'location')) {
      problems.push(`${key}: data-bound settings start at organization scope`);
    }
  }
  return problems;
}
