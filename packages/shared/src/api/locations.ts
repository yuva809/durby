import { z } from 'zod';

/** /api/v1/locations (docs/platform/web-shell.md → Locations, ADR 0056 → Branches). */

export const LOCATION_NAME_MAX_LENGTH = 100;
export const LOCATION_ADDRESS_MAX_LENGTH = 200;

const name = z.string().trim().min(1).max(LOCATION_NAME_MAX_LENGTH);
const address = z.string().trim().min(1).max(LOCATION_ADDRESS_MAX_LENGTH);

export const locationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  brandId: z.uuid(),
  /** The branch's address (ADR 0056); defaults for older apis. */
  address: z.string().nullable().default(null),
  /** Archived (ADR 0056): hidden from lists and pickers, its data kept. */
  archivedAt: z.iso.datetime().nullable().default(null),
  /** A warehouse's own place (ADR 0068), not a branch. Default for older apis. */
  isWarehouseSite: z.boolean().default(false),
});

export const locationListResponseSchema = z.object({ data: z.array(locationSchema) });

/** GET /api/v1/locations: active ones; `includeArchived=true` adds the archived ones (the Branches page). */
export const listLocationsQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/** POST /api/v1/locations: the brand is the organization's. */
export const locationRequestSchema = z.strictObject({
  name,
  address: address.optional(),
});

/** PATCH /api/v1/locations/:id: rename, set or clear the address (null), archive or restore. */
export const updateLocationRequestSchema = z
  .strictObject({
    name: name.optional(),
    address: address.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

/** Stable error codes of the location endpoints; the web app shows the matching label. */
export const LOCATION_ERROR_CODES = ['locations.name_taken', 'locations.in_use'] as const;

export type LocationErrorCode = (typeof LOCATION_ERROR_CODES)[number];
export type LocationSummary = z.infer<typeof locationSchema>;
export type LocationListResponse = z.infer<typeof locationListResponseSchema>;
export type LocationRequest = z.infer<typeof locationRequestSchema>;
export type UpdateLocationRequest = z.infer<typeof updateLocationRequestSchema>;
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;
