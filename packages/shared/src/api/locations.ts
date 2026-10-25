import { z } from 'zod';

/** Response of GET /api/v1/locations (docs/platform/web-shell.md → Locations). */

export const locationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  brandId: z.uuid(),
});

export const locationListResponseSchema = z.object({ data: z.array(locationSchema) });

export type LocationSummary = z.infer<typeof locationSchema>;
export type LocationListResponse = z.infer<typeof locationListResponseSchema>;
