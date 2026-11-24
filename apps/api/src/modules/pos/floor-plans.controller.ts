import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  type AreaFloorPlanResponse,
  type FloorPlanVersion,
  type LivePlansQuery,
  livePlansQuerySchema,
  type LivePlansResponse,
  type PublishFloorPlanRequest,
  publishFloorPlanRequestSchema,
  type PublishFloorPlanResponse,
  type RestoreFloorPlanRequest,
  restoreFloorPlanRequestSchema,
  type SaveFloorPlanRequest,
  saveFloorPlanRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { FloorPlansService } from './floor-plans.service';
import { posErrors } from './pos-errors';

const AreaId = () =>
  Param('areaId', new ParseUUIDPipe({ exceptionFactory: posErrors.areaNotFound }));
const Version = () =>
  Param('version', new ParseIntPipe({ exceptionFactory: posErrors.floorPlanNotFound }));

/**
 * Floor plans (docs/modules/pos.md → Step 8, ADR 0073). The guard checks the key for some location; the service checks
 * it at the area's. Writes append, so they complete their idempotency key in the business transaction (rule 8).
 */
@RequireFeature('pos')
@Controller('pos')
export class FloorPlansController {
  constructor(private readonly plans: FloorPlansService) {}

  @RequirePermission('pos.orders.read')
  @Get('floor/plans')
  async live(
    @Query(new ZodQuery(livePlansQuerySchema)) query: LivePlansQuery,
  ): Promise<LivePlansResponse> {
    return { data: await this.plans.livePlans(query.locationId) };
  }

  @RequirePermission('pos.tables.read')
  @Get('areas/:areaId/floor-plan')
  area(@AreaId() areaId: string): Promise<AreaFloorPlanResponse> {
    return this.plans.area(areaId);
  }

  @RequirePermission('pos.tables.read')
  @Get('areas/:areaId/floor-plan/versions/:version')
  version(@AreaId() areaId: string, @Version() version: number): Promise<FloorPlanVersion> {
    return this.plans.version(areaId, version);
  }

  @RequirePermission('pos.tables.edit')
  @Idempotent({ completion: 'transaction' })
  @Post('areas/:areaId/floor-plan/versions')
  save(
    @AreaId() areaId: string,
    @Body(new ZodBody(saveFloorPlanRequestSchema)) body: SaveFloorPlanRequest,
  ): Promise<FloorPlanVersion> {
    return this.plans.save(areaId, body);
  }

  @RequirePermission('pos.tables.edit')
  @Idempotent({ completion: 'transaction' })
  @Post('areas/:areaId/floor-plan/versions/:version/restore')
  restore(
    @AreaId() areaId: string,
    @Version() version: number,
    @Body(new ZodBody(restoreFloorPlanRequestSchema)) body: RestoreFloorPlanRequest,
  ): Promise<FloorPlanVersion> {
    return this.plans.restore(areaId, version, body.baseVersion);
  }

  @RequirePermission('pos.tables.edit')
  @Idempotent({ completion: 'transaction' })
  @Post('areas/:areaId/floor-plan/publish')
  publish(
    @AreaId() areaId: string,
    @Body(new ZodBody(publishFloorPlanRequestSchema)) body: PublishFloorPlanRequest,
  ): Promise<PublishFloorPlanResponse> {
    return this.plans.publish(areaId, body.version);
  }
}
