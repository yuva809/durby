import { z } from 'zod';
import { floorPlanLayoutSchema } from '../floor-plan/layout';

/** Bodies of the floor plan routes (docs/modules/pos.md → Step 8, ADR 0073). */

/** How many versions the history lists, newest first. */
export const FLOOR_PLAN_HISTORY = 50;

const version = z.int().min(1);

export const floorPlanVersionSchema = z.object({
  version,
  layout: floorPlanLayoutSchema,
});

export const floorPlanVersionInfoSchema = z.object({
  version,
  /** The version this one copies, when it was restored. */
  restoredFrom: version.nullable(),
  tables: z.int(),
  pieces: z.int(),
  createdAt: z.iso.datetime(),
  /** Display name; null for someone without one. */
  createdBy: z.string().nullable(),
});

export const areaFloorPlanResponseSchema = z.object({
  area: z.object({ id: z.uuid(), locationId: z.uuid(), name: z.string() }),
  /** The newest version; null before the first save. */
  latest: floorPlanVersionSchema.nullable(),
  /** The version the screens show; null before the first publish. */
  live: floorPlanVersionSchema.nullable(),
  history: z.array(floorPlanVersionInfoSchema),
});

/** `baseVersion`: the newest version the caller has seen (0 = none); a newer one answers 409. */
const baseVersion = z.int().min(0);

export const saveFloorPlanRequestSchema = z.strictObject({
  baseVersion,
  layout: floorPlanLayoutSchema,
});

export const restoreFloorPlanRequestSchema = z.strictObject({ baseVersion });

export const publishFloorPlanRequestSchema = z.strictObject({ version });

export const publishFloorPlanResponseSchema = z.object({
  /** The live version; a new one when tables were created. */
  version,
  layout: floorPlanLayoutSchema,
  created: z.array(z.object({ id: z.uuid(), name: z.string() })),
});

export const livePlansQuerySchema = z.object({ locationId: z.uuid() });

/** The live plan of each area of a location that has one. */
export const livePlansResponseSchema = z.object({
  data: z.array(
    z.object({ areaId: z.uuid(), areaName: z.string(), version, layout: floorPlanLayoutSchema }),
  ),
});

export type FloorPlanVersion = z.infer<typeof floorPlanVersionSchema>;
export type FloorPlanVersionInfo = z.infer<typeof floorPlanVersionInfoSchema>;
export type AreaFloorPlanResponse = z.infer<typeof areaFloorPlanResponseSchema>;
export type SaveFloorPlanRequest = z.infer<typeof saveFloorPlanRequestSchema>;
export type RestoreFloorPlanRequest = z.infer<typeof restoreFloorPlanRequestSchema>;
export type PublishFloorPlanRequest = z.infer<typeof publishFloorPlanRequestSchema>;
export type PublishFloorPlanResponse = z.infer<typeof publishFloorPlanResponseSchema>;
export type LivePlansQuery = z.infer<typeof livePlansQuerySchema>;
export type LivePlansResponse = z.infer<typeof livePlansResponseSchema>;
export type LivePlan = LivePlansResponse['data'][number];
