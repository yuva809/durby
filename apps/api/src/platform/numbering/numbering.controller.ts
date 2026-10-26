import { Idempotent } from '../markers';
import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import {
  type NumberSeries,
  type NumberSeriesListResponse,
  type PatchNumberSeriesRequest,
  patchNumberSeriesRequestSchema,
  type PutNumberSeriesCounterRequest,
  putNumberSeriesCounterRequestSchema,
} from '@durby/shared';
import { ZodBody } from '../http';
import { RequirePermission } from '../rbac';
import { NumberingAdmin } from './numbering-admin.service';

/**
 * /api/v1/number-series (docs/platform/numbering.md → API). Reuses the settings permissions
 * (ADR 0012 §10); writes check `platform.settings.manage` for all locations. Idempotency-Key for
 * the writes comes with platform/idempotency (step 1.9); both are naturally idempotent.
 */
@Controller('number-series')
export class NumberingController {
  constructor(private readonly admin: NumberingAdmin) {}

  @RequirePermission('platform.settings.read')
  @Get()
  async list(): Promise<NumberSeriesListResponse> {
    return { data: await this.admin.list() };
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent()
  @Patch(':key')
  update(
    @Param('key') key: string,
    @Body(new ZodBody(patchNumberSeriesRequestSchema)) body: PatchNumberSeriesRequest,
  ): Promise<NumberSeries> {
    return this.admin.update(key, body);
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent()
  @Put(':key/counter')
  raiseCounter(
    @Param('key') key: string,
    @Body(new ZodBody(putNumberSeriesCounterRequestSchema)) body: PutNumberSeriesCounterRequest,
  ): Promise<NumberSeries> {
    return this.admin.raiseCounter(key, body);
  }
}
