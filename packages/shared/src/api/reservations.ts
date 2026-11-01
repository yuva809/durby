import { z } from 'zod';
import { MAX_PARTY_SIZE } from '../reservation-settings';
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

/** Stable error codes of the reservations endpoints; the web app shows the matching label. */
export const RESERVATION_ERROR_CODES = ['reservations.location_not_found'] as const;

export type ReservationErrorCode = (typeof RESERVATION_ERROR_CODES)[number];
