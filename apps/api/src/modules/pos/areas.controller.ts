import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createDiningAreaRequestSchema,
  type CreateDiningAreaRequest,
  type DiningArea,
  type DiningAreaListResponse,
  listDiningAreasQuerySchema,
  type ListDiningAreasQuery,
  updateDiningAreaRequestSchema,
  type UpdateDiningAreaRequest,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { AreasService } from './areas.service';
import { posErrors } from './pos-errors';

/**
 * /api/v1/pos/areas (docs/modules/pos.md → Areas). Same keys as tables, checked at the area's
 * location by the service. Creates complete their idempotency key in the business transaction
 * (rule 8); renames and deletes are naturally idempotent.
 */
@RequireFeature('pos')
@Controller('pos/areas')
export class AreasController {
  constructor(private readonly areas: AreasService) {}

  @RequirePermission('pos.tables.read')
  @Get()
  async list(
    @Query(new ZodQuery(listDiningAreasQuerySchema)) query: ListDiningAreasQuery,
  ): Promise<DiningAreaListResponse> {
    return { data: await this.areas.list(query) };
  }

  @RequirePermission('pos.tables.create')
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(createDiningAreaRequestSchema)) body: CreateDiningAreaRequest,
  ): Promise<DiningArea> {
    return this.areas.create(body);
  }

  @RequirePermission('pos.tables.edit')
  @Idempotent()
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.areaNotFound })) id: string,
    @Body(new ZodBody(updateDiningAreaRequestSchema)) body: UpdateDiningAreaRequest,
  ): Promise<DiningArea> {
    return this.areas.update(id, body);
  }

  @RequirePermission('pos.tables.delete')
  @Idempotent()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.areaNotFound })) id: string,
  ): Promise<void> {
    return this.areas.remove(id);
  }
}
