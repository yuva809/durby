import { Controller, Get, Query } from '@nestjs/common';
import {
  type ReservationsFloorQuery,
  reservationsFloorQuerySchema,
  type ReservationsFloorResponse,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodQuery } from '../../platform/http';
import { RequirePermission } from '../../platform/rbac';
import { FloorService } from './floor.service';

/** The host floor (docs/modules/reservations.md → Derived floor state). The service checks the key at the location. */
@RequireFeature('reservations')
@Controller('reservations')
export class FloorController {
  constructor(private readonly floor: FloorService) {}

  @RequirePermission('reservations.bookings.read')
  @Get('floor')
  async get(
    @Query(new ZodQuery(reservationsFloorQuerySchema)) query: ReservationsFloorQuery,
  ): Promise<ReservationsFloorResponse> {
    return this.floor.floor(query);
  }
}
