import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { CURRENCY_CODES } from './currencies';
import {
  DEFAULT_TURN_TIMES,
  MAX_PARTY_SIZE,
  SLOT_INTERVALS,
  turnTimesSchema,
} from './reservation-settings';
import { DEFAULT_POS_PRINTERS, posPrintersReadSchema, posPrintersSchema } from './native-print';
import { countryCodeSchema } from './phone';
import {
  billFooterSchema,
  billHeaderSchema,
  billTextSchema,
  DEFAULT_BILL_FOOTER,
  DEFAULT_BILL_HEADER,
  DEFAULT_BILL_TEXT,
  DEFAULT_TICKET_TEXT,
  ticketTextSchema,
} from './pos-bill-settings';
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
  /** Validates writes: strict, so stored values never carry free-form fields. */
  schema: S;
  /**
   * Forward-compatible reading (ADR 0033), for keys a later release may extend: drops what this release doesn't
   * know and then validates with `schema`, so a value saved by the next release still resolves here after a
   * rollback. Missing: reads use `schema`.
   */
  read?: z.ZodType<z.infer<S>>;
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
  // Reads local phone numbers of the location's guests (docs/modules/reservations.md → GDPR).
  country: define({
    label: 'platform.settings.country.name',
    description: 'platform.settings.country.description',
    schema: countryCodeSchema,
    default: 'DE',
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
  // Reservations (docs/modules/reservations.md → Settings): defaults that let a new location take
  // bookings without setup. Read at the booking's location.
  'reservations.serviceHours': define({
    label: 'platform.settings.reservationsServiceHours.name',
    description: 'platform.settings.reservationsServiceHours.description',
    // 'openingHours' = the opening hours; a schedule only narrows them (the engine intersects). Not
    // null: a stored setting is never JSON null (ADR 0010), and a location must be able to say this.
    schema: z.union([z.literal('openingHours'), weeklyHoursSchema]),
    default: 'openingHours',
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'reservations.slotIntervalMinutes': define({
    label: 'platform.settings.reservationsSlotIntervalMinutes.name',
    description: 'platform.settings.reservationsSlotIntervalMinutes.description',
    schema: z.literal(SLOT_INTERVALS),
    default: 15,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'reservations.turnTimes': define({
    label: 'platform.settings.reservationsTurnTimes.name',
    description: 'platform.settings.reservationsTurnTimes.description',
    schema: turnTimesSchema,
    default: DEFAULT_TURN_TIMES,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'reservations.maxCoversPerSlot': define({
    label: 'platform.settings.reservationsMaxCoversPerSlot.name',
    description: 'platform.settings.reservationsMaxCoversPerSlot.description',
    // 'off' = no pacing limit (a value, not null: a location can switch off its organization's limit).
    schema: z.union([z.literal('off'), z.int().min(1).max(1000)]),
    default: 'off',
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'reservations.lastBookingOffsetMinutes': define({
    label: 'platform.settings.reservationsLastBookingOffsetMinutes.name',
    description: 'platform.settings.reservationsLastBookingOffsetMinutes.description',
    schema: z.int().min(1).max(480),
    default: 60,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'reservations.online.instantMaxParty': define({
    label: 'platform.settings.reservationsOnlineInstantMaxParty.name',
    description: 'platform.settings.reservationsOnlineInstantMaxParty.description',
    // A threshold, not a block: larger online parties become a Requested booking the host accepts
    // or declines (R2). 'off' = every size books instantly. Capacity is separate: slots no table
    // or combination fits are never offered.
    schema: z.union([z.literal('off'), z.int().min(1).max(MAX_PARTY_SIZE)]),
    default: 10,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // How far a till order's opening may be from a booking's start to belong to that party (R1.7):
  // auto-seat, manual seat over an open order, and finish on close all use it.
  'reservations.orderMatchWindowMinutes': define({
    label: 'platform.settings.reservationsOrderMatchWindowMinutes.name',
    description: 'platform.settings.reservationsOrderMatchWindowMinutes.description',
    schema: z.int().min(5).max(120),
    default: 30,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // How far ahead the host floor marks a table "reserved soon" (R1.8a).
  'reservations.floorHorizonMinutes': define({
    label: 'platform.settings.reservationsFloorHorizonMinutes.name',
    description: 'platform.settings.reservationsFloorHorizonMinutes.description',
    schema: z.int().min(15).max(240),
    default: 60,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'reservations.autoConfirm': define({
    label: 'platform.settings.reservationsAutoConfirm.name',
    description: 'platform.settings.reservationsAutoConfirm.description',
    schema: z.boolean(),
    default: true,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'reservations.holdMinutes': define({
    label: 'platform.settings.reservationsHoldMinutes.name',
    description: 'platform.settings.reservationsHoldMinutes.description',
    schema: z.int().min(1).max(15),
    default: 5,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // The printed bill's header and footer (docs/modules/pos.md → Bill layout, ADR 0025); the middle
  // part is the same for everyone. Read at the order's location.
  'pos.billHeader': define({
    label: 'platform.settings.posBillHeader.name',
    description: 'platform.settings.posBillHeader.description',
    schema: billHeaderSchema,
    default: DEFAULT_BILL_HEADER,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'pos.billFooter': define({
    label: 'platform.settings.posBillFooter.name',
    description: 'platform.settings.posBillFooter.description',
    schema: billFooterSchema,
    default: DEFAULT_BILL_FOOTER,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // Text sizes of the printed bill and of kitchen and bar tickets (docs/modules/pos.md → Text size).
  'pos.billText': define({
    label: 'platform.settings.posBillText.name',
    description: 'platform.settings.posBillText.description',
    schema: billTextSchema,
    default: DEFAULT_BILL_TEXT,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'pos.ticketText': define({
    label: 'platform.settings.posTicketText.name',
    description: 'platform.settings.posTicketText.description',
    schema: ticketTextSchema,
    default: DEFAULT_TICKET_TEXT,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // The LAN printers the Durby Android app prints to (ADR 0032 §6); read with the bill layout.
  'pos.printers': define({
    label: 'platform.settings.posPrinters.name',
    description: 'platform.settings.posPrinters.description',
    schema: posPrintersSchema,
    read: posPrintersReadSchema,
    default: DEFAULT_POS_PRINTERS,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // A print job this old is never printed by itself (ADR 0033): a ticket from long ago would only confuse the
  // kitchen. Fixed per job when it is queued; staff can still reprint it.
  'pos.printJobMaxAgeSeconds': define({
    label: 'platform.settings.posPrintJobMaxAgeSeconds.name',
    description: 'platform.settings.posPrintJobMaxAgeSeconds.description',
    schema: z.number().int().min(60).max(86_400),
    default: 600,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // Off: that station's items go straight to the bill, no ticket to prepare (ADR 0031).
  'pos.kitchenProcessing': define({
    label: 'platform.settings.posKitchenProcessing.name',
    description: 'platform.settings.posKitchenProcessing.description',
    schema: z.boolean(),
    default: true,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  'pos.barProcessing': define({
    label: 'platform.settings.posBarProcessing.name',
    description: 'platform.settings.posBarProcessing.description',
    schema: z.boolean(),
    default: true,
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
  // The food cost a dish should have: the suggested price is cost ÷ target (docs/modules/inventory.md).
  'inventory.targetFoodCostPercent': define({
    label: 'platform.settings.inventoryTargetFoodCostPercent.name',
    description: 'platform.settings.inventoryTargetFoodCostPercent.description',
    schema: z.int().min(1).max(100),
    default: 30,
    scopes: ['partner', 'organization'],
    dataBound: false,
  }),
  'inventory.allowNegativeStock': define({
    label: 'platform.settings.inventoryAllowNegativeStock.name',
    description: 'platform.settings.inventoryAllowNegativeStock.description',
    schema: z.boolean(),
    default: false,
    scopes: ALL_SCOPES,
    dataBound: false,
  }),
  // On: a password an owner or admin sets for staff is final; staff never choose or reset their own (ADR 0052).
  'team.adminsManageSignIn': define({
    label: 'platform.settings.teamAdminsManageSignIn.name',
    description: 'platform.settings.teamAdminsManageSignIn.description',
    schema: z.boolean(),
    default: false,
    scopes: ['partner', 'organization'],
    dataBound: false,
  }),
  // Off: a branch's stock request is approved as it is sent, with its transfer number (ADR 0056).
  'orders.requestsNeedApproval': define({
    label: 'platform.settings.ordersRequestsNeedApproval.name',
    description: 'platform.settings.ordersRequestsNeedApproval.description',
    schema: z.boolean(),
    default: true,
    scopes: ['partner', 'organization'],
    dataBound: false,
  }),
  // Off: the Sales Orders menu is hidden for the organization (the page stays reachable by its address).
  'orders.showSalesOrders': define({
    label: 'platform.settings.ordersShowSalesOrders.name',
    description: 'platform.settings.ordersShowSalesOrders.description',
    schema: z.boolean(),
    default: true,
    scopes: ['partner', 'organization'],
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
    if (def.read) {
      const read = def.read.safeParse(def.default);
      if (!read.success || !def.schema.safeParse(read.data).success) {
        problems.push(`${key}: the read schema must read the default as the schema does`);
      }
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
