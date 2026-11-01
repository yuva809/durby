import { z } from 'zod';
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

/** Stable error codes of the reservations endpoints; the web app shows the matching label. */
export const RESERVATION_ERROR_CODES = ['reservations.location_not_found'] as const;

export type ReservationErrorCode = (typeof RESERVATION_ERROR_CODES)[number];
