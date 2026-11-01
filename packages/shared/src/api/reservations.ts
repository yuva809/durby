import { z } from 'zod';
import { MAX_PARTY_SIZE } from '../reservation-settings';
import { SETTING_KEYS, type SettingKey, settingAllowsScope } from '../settings';
import { weeklyHoursSchema } from '../time/opening-hours';
import { resolvedSettingSchema } from './settings';
import { isLocalDate } from '../time/zoned';
import { TABLE_COLORS, TABLE_SHAPES } from './pos-tables';

/** Request and response bodies of the reservations endpoints (docs/modules/reservations.md → API). */

export const reservationsFloorQuerySchema = z.object({ locationId: z.uuid() });

/**
 * A table of the host floor: the table and whether a party sits at it now. Built from pos's read
 * port (PosFloorReader); it carries no order data (id, number, items or totals), so roles without
 * pos order keys (Host) can see it.
 */
export const reservationsFloorTableSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  seats: z.int(),
  areaId: z.uuid().nullable(),
  area: z.string().nullable(),
  shape: z.enum(TABLE_SHAPES),
  color: z.enum(TABLE_COLORS),
  sortOrder: z.int(),
  /** An open pos order holds the table. */
  occupied: z.boolean(),
  /** When that order was opened; null when free. */
  occupiedSince: z.iso.datetime().nullable(),
  /** Guests at the table (pos covers), or null when free or not recorded. */
  covers: z.int().nullable(),
});

export const reservationsFloorResponseSchema = z.object({
  data: z.array(reservationsFloorTableSchema),
});

export type ReservationsFloorQuery = z.infer<typeof reservationsFloorQuerySchema>;
export type ReservationsFloorTable = z.infer<typeof reservationsFloorTableSchema>;
export type ReservationsFloorResponse = z.infer<typeof reservationsFloorResponseSchema>;

/** GET /reservations/availability: one local day of a location for a party size. */
export const reservationAvailabilityQuerySchema = z.object({
  locationId: z.uuid(),
  date: z.string().refine(isLocalDate, { message: 'Expected a date YYYY-MM-DD' }),
  partySize: z.coerce.number().int().min(1).max(MAX_PARTY_SIZE),
});

export const reservationAllocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), tableId: z.uuid() }),
  z.object({
    kind: z.literal('combination'),
    combinationId: z.uuid(),
    tableIds: z.array(z.uuid()),
  }),
]);

/**
 * A slot of the day (docs/modules/reservations.md → Availability engine): `available` books now,
 * `request` becomes a Requested booking (online, above the instant threshold), `full` is shown but
 * not bookable (`reason`: no table or combination is free, or the pacing limit is reached).
 */
export const reservationSlotSchema = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  status: z.enum(['available', 'request', 'full']),
  reason: z.enum(['no_table', 'pacing']).optional(),
  /** The table or combination chosen; for a request only a hint (a request holds no table). */
  allocation: reservationAllocationSchema.optional(),
});

export const reservationAvailabilityResponseSchema = z.object({
  date: z.string(),
  /** The party's turn time, in minutes: each slot's end is its start plus this. */
  turnMinutes: z.int(),
  /** The location is closed that day (closed dates); no slots. */
  closed: z.boolean(),
  slots: z.array(reservationSlotSchema),
});

export type ReservationAvailabilityQuery = z.infer<typeof reservationAvailabilityQuerySchema>;
export type ReservationAllocation = z.infer<typeof reservationAllocationSchema>;
export type ReservationSlot = z.infer<typeof reservationSlotSchema>;
export type ReservationAvailabilityResponse = z.infer<typeof reservationAvailabilityResponseSchema>;

// --- Setup: table rules and combinations (docs/modules/reservations.md → R1.5 setup API) ---

export const TABLE_BOOKING_MODES = ['all', 'staff_only', 'walk_in_only'] as const;
export type TableBookingMode = (typeof TABLE_BOOKING_MODES)[number];

export const COMBINATION_NAME_MAX_LENGTH = 60;
export const COMBINATION_MIN_TABLES = 2;
export const COMBINATION_MAX_TABLES = 8;

const partySize = z.int().min(1).max(MAX_PARTY_SIZE);

export const reservationTablesQuerySchema = z.object({ locationId: z.uuid() });

/** A table in service with its rule; a table without a stored rule shows the defaults. */
export const reservationTableSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  seats: z.int(),
  areaId: z.uuid().nullable(),
  area: z.string().nullable(),
  sortOrder: z.int(),
  bookingMode: z.enum(TABLE_BOOKING_MODES),
  minParty: z.int(),
  /** null = the table's seats. */
  maxParty: z.int().nullable(),
});

export const reservationTablesResponseSchema = z.object({ data: z.array(reservationTableSchema) });

/**
 * PUT /reservations/tables/:tableId/rule: replaces the rule. The api checks min ≤ max and min ≤ the
 * table's capacity (422 reservations.party_range_invalid).
 */
export const putTableRuleRequestSchema = z.strictObject({
  bookingMode: z.enum(TABLE_BOOKING_MODES),
  minParty: partySize,
  maxParty: partySize.nullable(),
});

export const reservationCombinationsQuerySchema = z.object({
  locationId: z.uuid(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const reservationCombinationSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  /** Sorted by id: a stable order. */
  tableIds: z.array(z.uuid()),
  minParty: z.int(),
  maxParty: z.int(),
  onlineBookable: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
});

export const reservationCombinationsResponseSchema = z.object({
  data: z.array(reservationCombinationSchema),
});

const combinationName = z.string().trim().min(1).max(COMBINATION_NAME_MAX_LENGTH);
const combinationTables = z
  .array(z.uuid())
  .min(COMBINATION_MIN_TABLES)
  .max(COMBINATION_MAX_TABLES)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Tables repeat' });

/** The api checks min ≤ max (422 reservations.party_range_invalid), on a patch with stored values. */
export const createCombinationRequestSchema = z.strictObject({
  locationId: z.uuid(),
  name: combinationName,
  tableIds: combinationTables,
  minParty: partySize,
  maxParty: partySize,
  onlineBookable: z.boolean().optional(),
});

export const updateCombinationRequestSchema = z
  .strictObject({
    name: combinationName.optional(),
    tableIds: combinationTables.optional(),
    minParty: partySize.optional(),
    maxParty: partySize.optional(),
    onlineBookable: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export type ReservationTablesQuery = z.infer<typeof reservationTablesQuerySchema>;
export type ReservationTable = z.infer<typeof reservationTableSchema>;
export type ReservationTablesResponse = z.infer<typeof reservationTablesResponseSchema>;
export type PutTableRuleRequest = z.infer<typeof putTableRuleRequestSchema>;
export type ReservationCombinationsQuery = z.infer<typeof reservationCombinationsQuerySchema>;
export type ReservationCombination = z.infer<typeof reservationCombinationSchema>;
export type ReservationCombinationsResponse = z.infer<typeof reservationCombinationsResponseSchema>;
export type CreateCombinationRequest = z.infer<typeof createCombinationRequestSchema>;
export type UpdateCombinationRequest = z.infer<typeof updateCombinationRequestSchema>;

// --- The location's reservation settings (R1.5c, ADR 0020) ---

/**
 * The settings `reservations.setup.manage` may set at a location: the module's own keys that allow
 * location scope. Platform-wide keys (openingHours, closedDates, timezone, …) are never among them.
 */
export const RESERVATION_LOCATION_SETTING_KEYS = SETTING_KEYS.filter(
  (key) => key.startsWith('reservations.') && settingAllowsScope(key, 'location'),
) as readonly SettingKey[];

export const reservationSettingsQuerySchema = z.object({ locationId: z.uuid() });

export const reservationSettingKeySchema = z.enum(
  RESERVATION_LOCATION_SETTING_KEYS as [SettingKey, ...SettingKey[]],
);

export const reservationSettingsResponseSchema = z.object({
  /** RESERVATION_LOCATION_SETTING_KEYS resolved at the location, in registry order. */
  data: z.array(resolvedSettingSchema),
  /** The location's opening hours (read-only here), to explain service hours. */
  openingHours: weeklyHoursSchema,
});

export type ReservationSettingsQuery = z.infer<typeof reservationSettingsQuerySchema>;
export type ReservationSettingsResponse = z.infer<typeof reservationSettingsResponseSchema>;

/** Stable error codes of the reservations endpoints; the web app shows the matching label. */
export const RESERVATION_ERROR_CODES = [
  'reservations.location_not_found',
  'reservations.table_not_found',
  'reservations.combination_not_found',
  'reservations.party_range_invalid',
] as const;

export type ReservationErrorCode = (typeof RESERVATION_ERROR_CODES)[number];
