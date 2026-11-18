import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import {
  REALTIME_STREAMS,
  type RealtimeStreamQuery,
  realtimeStreamQuerySchema,
} from '@durby/shared';
import type { Request, Response } from 'express';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodQuery } from '../../platform/http';
import { RealtimeStreams } from '../../platform/realtime';
import { AccessService, RequirePermission } from '../../platform/rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../../platform/tenancy';
import { posErrors } from './pos-errors';

/**
 * Live updates for /service (docs/platform/realtime.md, ADR 0044): hints on the `pos.floor` topic at
 * one location (orders opened and closed, tickets sent). The location check runs in its own short
 * transaction before the stream opens; the open stream holds no database connection.
 */
@RequireFeature('pos')
@Controller('pos')
export class PosStreamController {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly streams: RealtimeStreams,
  ) {}

  @RequirePermission('pos.orders.read')
  @Get('stream')
  async stream(
    @Query(new ZodQuery(realtimeStreamQuerySchema)) query: RealtimeStreamQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { locationId } = query;
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      // A location the caller can't read orders at doesn't exist for them (404, like unknown ids).
      const scope = await this.access.locationIdsFor('pos.orders.read');
      if (scope !== 'all' && !scope.includes(locationId)) throw posErrors.locationNotFound();
      const location = await tx.location.findUnique({
        where: { id: locationId },
        select: { id: true },
      });
      if (!location) throw posErrors.locationNotFound();
    });
    await this.streams.open(req, res, { locationId, topics: REALTIME_STREAMS.pos });
  }
}
