import { z } from 'zod';

/** /api/v1/locations (docs/platform/web-shell.md → Locations). */

export const LOCATION_NAME_MAX_LENGTH = 100;

export const locationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  brandId: z.uuid(),
});

export const locationListResponseSchema = z.object({ data: z.array(locationSchema) });

/** POST and PATCH /api/v1/locations(/:id): only the name; the brand is the organization's. */
export const locationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(LOCATION_NAME_MAX_LENGTH),
});

/** Stable error codes of the location endpoints; the web app shows the matching label. */
export const LOCATION_ERROR_CODES = ['locations.name_taken', 'locations.in_use'] as const;

export type LocationErrorCode = (typeof LOCATION_ERROR_CODES)[number];
export type LocationSummary = z.infer<typeof locationSchema>;
export type LocationListResponse = z.infer<typeof locationListResponseSchema>;
export type LocationRequest = z.infer<typeof locationRequestSchema>;
