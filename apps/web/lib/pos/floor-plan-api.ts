import {
  type AreaFloorPlanResponse,
  areaFloorPlanResponseSchema,
  type FloorPlanLayout,
  type FloorPlanVersion,
  floorPlanVersionSchema,
  type LivePlan,
  livePlansResponseSchema,
  type PublishFloorPlanResponse,
  publishFloorPlanResponseSchema,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of the floor plan (docs/modules/pos.md → Step 8, ADR 0073), parsed with the shared schemas. */

const base = (areaId: string) => `/api/v1/pos/areas/${areaId}/floor-plan`;

export const loadAreaPlan = (store: Api, areaId: string): Promise<Result<AreaFloorPlanResponse>> =>
  read(store, base(areaId), areaFloorPlanResponseSchema);

export const loadPlanVersion = (
  store: Api,
  areaId: string,
  version: number,
): Promise<Result<FloorPlanVersion>> =>
  read(store, `${base(areaId)}/versions/${version}`, floorPlanVersionSchema);

export const savePlan = (
  store: Api,
  action: ActionKey,
  areaId: string,
  body: { baseVersion: number; layout: FloorPlanLayout },
): Promise<Result<FloorPlanVersion | null>> =>
  write(store, action, `${base(areaId)}/versions`, 'POST', body, floorPlanVersionSchema);

export const restorePlan = (
  store: Api,
  action: ActionKey,
  areaId: string,
  version: number,
  baseVersion: number,
): Promise<Result<FloorPlanVersion | null>> =>
  write(
    store,
    action,
    `${base(areaId)}/versions/${version}/restore`,
    'POST',
    { baseVersion },
    floorPlanVersionSchema,
  );

export const publishPlan = (
  store: Api,
  action: ActionKey,
  areaId: string,
  version: number,
): Promise<Result<PublishFloorPlanResponse | null>> =>
  write(
    store,
    action,
    `${base(areaId)}/publish`,
    'POST',
    { version },
    publishFloorPlanResponseSchema,
  );

/** The live plans of a location's areas. */
export const loadLivePlans = (store: Api, locationId: string): Promise<Result<LivePlan[]>> =>
  read(
    store,
    `/api/v1/pos/floor/plans?locationId=${encodeURIComponent(locationId)}`,
    list(livePlansResponseSchema),
  );
