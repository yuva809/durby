import { z } from 'zod';

/** Request and response bodies of /api/v1/pos/areas (docs/modules/pos.md → Areas). */

export const AREA_NAME_MAX_LENGTH = 50;

const areaName = z.string().trim().min(1).max(AREA_NAME_MAX_LENGTH);
const sortOrder = z.int().min(0).max(1_000_000);

export const diningAreaSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  sortOrder: z.int(),
  /** Tables in service in this area. */
  tableCount: z.int(),
});

export const createDiningAreaRequestSchema = z.strictObject({
  locationId: z.uuid(),
  name: areaName,
  sortOrder: sortOrder.optional(),
});

export const updateDiningAreaRequestSchema = z
  .strictObject({ name: areaName.optional(), sortOrder: sortOrder.optional() })
  .refine((body) => body.name !== undefined || body.sortOrder !== undefined, {
    message: 'Nothing to update',
  });

export const listDiningAreasQuerySchema = z.object({ locationId: z.uuid().optional() });

export const diningAreaListResponseSchema = z.object({ data: z.array(diningAreaSchema) });

export type DiningArea = z.infer<typeof diningAreaSchema>;
export type CreateDiningAreaRequest = z.infer<typeof createDiningAreaRequestSchema>;
export type UpdateDiningAreaRequest = z.infer<typeof updateDiningAreaRequestSchema>;
export type ListDiningAreasQuery = z.infer<typeof listDiningAreasQuerySchema>;
export type DiningAreaListResponse = z.infer<typeof diningAreaListResponseSchema>;
