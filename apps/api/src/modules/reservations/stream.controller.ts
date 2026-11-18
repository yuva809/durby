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
import { readableLocation } from './setup/table-rules.service';

/**
 * Live updates for /host, /reservations and the /service badges (docs/platform/realtime.md, ADR
 * 0044): hints on the `reservations` topic at one location. The location check runs in its own
 * short transaction before the stream opens; the open stream holds no database connection.
 */
@RequireFeature('reservations')
@Controller('reservations')
export class ReservationsStreamController {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly streams: RealtimeStreams,
  ) {}

  @RequirePermission('reservations.bookings.read')
  @Get('stream')
  async stream(
    @Query(new ZodQuery(realtimeStreamQuerySchema)) query: RealtimeStreamQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await readableLocation(tx, this.access, query.locationId);
    });
    await this.streams.open(req, res, {
      locationId: query.locationId,
      topics: REALTIME_STREAMS.reservations,
    });
  }
}
