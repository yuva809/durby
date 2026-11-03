import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { MAX_PARTY_SIZE } from '../reservation-settings';
import { SETTING_KEYS, type SettingKey, settingAllowsScope } from '../settings';
import { weeklyHoursSchema } from '../time/opening-hours';
import { resolvedSettingSchema } from './settings';
import { isLocalDate } from '../time/zoned';
import { TABLE_COLORS, TABLE_SHAPES } from './pos-tables';

/** Request and response bodies of the reservations endpoints (docs/modules/reservations.md → API). */

/**
 * GET /reservations/floor: now, an instant (`at`) or a local day (`date`: today = now, another day =
 * the start of its first service window).
 */
export const reservationsFloorQuerySchema = z
  .object({
    locationId: z.uuid(),
    at: z.iso.datetime({ offset: true }).optional(),
    date: z.string().refine(isLocalDate, { message: 'Expected a date YYYY-MM-DD' }).optional(),
  })
  .refine((q) => q.at === undefined || q.date === undefined, {
    message: 'Pass at or date, not both',
  });

export const FLOOR_STATES = ['occupied', 'arriving', 'reserved', 'reserved_soon', 'free'] as const;
export type FloorState = (typeof FLOOR_STATES)[number];

/**
 * A table of the host floor at a moment (docs/modules/reservations.md → Derived floor state). Built
 * from pos's read port (PosFloorReader) and the bookings; it carries no order data (id, number,
 * items or totals), so roles without pos order keys (Host) can see it.
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
  state: z.enum(FLOOR_STATES),
  /** Live: a seated party is past its planned end. */
  overrun: z.boolean(),
  /** The table takes walk-ins only (badge). */
  walkInOnly: z.boolean(),
  /** What the state comes from (occupied, arriving, reserved); null otherwise. */
  current: z
    .object({
      /** null for a till order without a booking. */
      reservationId: z.uuid().nullable(),
      partySize: z.int().nullable(),
      guestName: z.string().nullable(),
      since: z.iso.datetime(),
      until: z.iso.datetime().nullable(),
    })
    .nullable(),
  /** The earliest other booking on the table that hasn't ended. */
  next: z
    .object({
      reservationId: z.uuid(),
      startsAt: z.iso.datetime(),
      partySize: z.int(),
      guestName: z.string().nullable(),
      /** Live: the table is still occupied past this booking's start: move the booking. */
      tableStillOccupied: z.boolean(),
    })
    .nullable(),
  /** state === 'occupied'. */
  occupied: z.boolean(),
  /** current.since while occupied; null otherwise. */
  occupiedSince: z.iso.datetime().nullable(),
  /** Guests at the table while occupied (pos covers, or the seated party), or null. */
  covers: z.int().nullable(),
});

export const reservationsFloorResponseSchema = z.object({
  data: z.array(reservationsFloorTableSchema),
  /** The moment shown. */
  at: z.iso.datetime(),
  /** Its local date at the location. */
  date: z.string(),
  /** Today at the location: open orders, overrun and arriving count. */
  live: z.boolean(),
  /** The date's service windows (opening hours narrowed by the reservation hours). */
  serviceWindows: z.array(z.object({ start: z.iso.datetime(), end: z.iso.datetime() })),
});

export type ReservationsFloorQuery = z.infer<typeof reservationsFloorQuerySchema>;
export type ReservationsFloorTable = z.infer<typeof reservationsFloorTableSchema>;
export type ReservationsFloorResponse = z.infer<typeof reservationsFloorResponseSchema>;

/** GET /reservations/availability: one local day of a location for a party size. */
export const reservationAvailabilityQuerySchema = z.object({
  locationId: z.uuid(),
  date: z.string().refine(isLocalDate, { message: 'Expected a date YYYY-MM-DD' }),
  partySize: z.coerce.number().int().min(1).max(MAX_PARTY_SIZE),
  /** Moving a booking: it doesn't block itself (R1.6b). */
  excludeReservationId: z.uuid().optional(),
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

// --- Bookings (R1.6b, docs/modules/reservations.md → R1.6 bookings API) ---

export const RESERVATION_STATUSES = [
  'requested',
  'pending',
  'booked',
  'arrived',
  'seated',
  'finished',
  'no_show',
  'cancelled',
  'declined',
  'expired',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_SOURCES = ['staff', 'online', 'walk_in'] as const;

/** The longest booking (and the longest list range, in days). */
export const MAX_BOOKING_MINUTES = 720;
export const MAX_LIST_DAYS = 31;

const optionalText = (max: number) => z.string().trim().min(1).max(max);
const guestEmail = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Guest details as staff type them; the api normalises the phone with the location's country. */
export const reservationGuestInputSchema = z.strictObject({
  name: optionalText(100).optional(),
  email: guestEmail.optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  locale: z.enum(LOCALES).optional(),
});

const tableIdList = z
  .array(z.uuid())
  .min(1)
  .max(COMBINATION_MAX_TABLES)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Tables repeat' });

export const createReservationRequestSchema = z
  .strictObject({
    locationId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    /** Default: start + the party's turn time. */
    endsAt: z.iso.datetime({ offset: true }).optional(),
    partySize: z.int().min(1).max(MAX_PARTY_SIZE),
    /** Default: the engine's table choice at that exact start. */
    tableIds: tableIdList.optional(),
    guest: reservationGuestInputSchema,
    guestNote: optionalText(500).optional(),
    staffNote: optionalText(500).optional(),
    /** Book past the pacing limit or outside the reservation hours (audited). */
    force: z.boolean().optional(),
  })
  .refine((b) => b.endsAt === undefined || bookingLengthOk(b.startsAt, b.endsAt), {
    message: `endsAt must be after startsAt, at most ${MAX_BOOKING_MINUTES} minutes`,
    path: ['endsAt'],
  });

export const updateReservationRequestSchema = z
  .strictObject({
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    partySize: z.int().min(1).max(MAX_PARTY_SIZE).optional(),
    tableIds: tableIdList.optional(),
    guest: reservationGuestInputSchema.optional(),
    guestNote: optionalText(500).nullable().optional(),
    staffNote: optionalText(500).nullable().optional(),
    force: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'force'), { message: 'Nothing to update' });

function bookingLengthOk(startsAt: string, endsAt: string): boolean {
  const minutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60_000;
  return minutes > 0 && minutes <= MAX_BOOKING_MINUTES;
}

export const reservationsListQuerySchema = z
  .object({
    locationId: z.uuid(),
    /** A local day at the location… */
    date: z.string().refine(isLocalDate, { message: 'Expected a date YYYY-MM-DD' }).optional(),
    /** …or an instant range of at most MAX_LIST_DAYS days. */
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    status: z.enum(RESERVATION_STATUSES).optional(),
  })
  .refine(
    (q) =>
      q.date !== undefined
        ? q.from === undefined && q.to === undefined
        : q.from !== undefined &&
          q.to !== undefined &&
          Date.parse(q.to) > Date.parse(q.from) &&
          Date.parse(q.to) - Date.parse(q.from) <= MAX_LIST_DAYS * 86_400_000,
    { message: `Pass date, or from and to at most ${MAX_LIST_DAYS} days apart` },
  );

export const reservationGuestSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  locale: z.string(),
});

export const reservationStatusChangeSchema = z.object({
  id: z.uuid(),
  fromStatus: z.enum(RESERVATION_STATUSES).nullable(),
  toStatus: z.enum(RESERVATION_STATUSES),
  undoesId: z.uuid().nullable(),
  actorKind: z.enum(['user', 'guest', 'system']),
  /** The till order behind a system change (auto-seat, finish on close); null otherwise. */
  sourceOrderId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const reservationSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  locationId: z.uuid(),
  status: z.enum(RESERVATION_STATUSES),
  source: z.enum(RESERVATION_SOURCES),
  partySize: z.int(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** Sorted by id. */
  tableIds: z.array(z.uuid()),
  guest: reservationGuestSchema,
  guestNote: z.string().nullable(),
  staffNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** The latest status change: what an undo would revert (R1.6c). */
  lastChangeId: z.uuid(),
  /** That change: the host's badges ("auto-seated from till": actorKind system + sourceOrderId). */
  lastChange: reservationStatusChangeSchema.omit({ fromStatus: true, undoesId: true }),
  /** A blocking booking's tables that pos has archived since (move the booking); else []. */
  tablesNotInService: z.array(z.uuid()),
});

/** POST /reservations/:id/seat: optionally at other tables. */
export const seatReservationRequestSchema = z.strictObject({ tableIds: tableIdList.optional() });

/** POST /reservations/:id/undo: the change the client saw (409 if it isn't the latest). */
export const undoReservationRequestSchema = z.strictObject({ changeId: z.uuid() });

/** The shortest walk-in when the host seats someone until the next booking. */
export const MIN_WALK_IN_MINUTES = 15;

export const createWalkInRequestSchema = z.strictObject({
  locationId: z.uuid(),
  partySize: z.int().min(1).max(MAX_PARTY_SIZE),
  tableIds: tableIdList,
  name: optionalText(100).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  /** Default: now + the party's turn time. */
  endsAt: z.iso.datetime({ offset: true }).optional(),
});

export type SeatReservationRequest = z.infer<typeof seatReservationRequestSchema>;
export type UndoReservationRequest = z.infer<typeof undoReservationRequestSchema>;
export type CreateWalkInRequest = z.infer<typeof createWalkInRequestSchema>;

export const reservationDetailSchema = reservationSchema.extend({
  /** Oldest first. */
  history: z.array(reservationStatusChangeSchema),
});

export const reservationsListResponseSchema = z.object({ data: z.array(reservationSchema) });

export type ReservationGuestInput = z.infer<typeof reservationGuestInputSchema>;
export type CreateReservationRequest = z.infer<typeof createReservationRequestSchema>;
export type UpdateReservationRequest = z.infer<typeof updateReservationRequestSchema>;
export type ReservationsListQuery = z.infer<typeof reservationsListQuerySchema>;
export type Reservation = z.infer<typeof reservationSchema>;
export type ReservationDetail = z.infer<typeof reservationDetailSchema>;
export type ReservationsListResponse = z.infer<typeof reservationsListResponseSchema>;

/** Stable error codes of the reservations endpoints; the web app shows the matching label. */
export const RESERVATION_ERROR_CODES = [
  'reservations.location_not_found',
  'reservations.table_not_found',
  'reservations.combination_not_found',
  'reservations.party_range_invalid',
  'reservations.reservation_not_found',
  'reservations.table_walk_in_only',
  'reservations.party_size_out_of_range',
  'reservations.table_occupied',
  'reservations.table_unavailable',
  'reservations.pacing_exceeded',
  'reservations.outside_service_hours',
  'reservations.starts_in_past',
  'reservations.phone_invalid',
  'reservations.invalid_transition',
  'reservations.undo_expired',
  'reservations.table_not_in_service',
  'reservations.busy',
] as const;

export type ReservationErrorCode = (typeof RESERVATION_ERROR_CODES)[number];
