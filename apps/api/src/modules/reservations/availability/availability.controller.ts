import { Controller, Get, Query } from '@nestjs/common';
import {
  type ReservationAvailabilityQuery,
  reservationAvailabilityQuerySchema,
  type ReservationAvailabilityResponse,
} from '@durby/shared';
import { Clock } from '../../../platform/auth';
import { RequireFeature } from '../../../platform/config/entitlements';
import { ZodQuery } from '../../../platform/http';
import { AccessService, RequirePermission } from '../../../platform/rbac';
import { reservationErrors } from '../reservations-errors';
import { AvailabilityLoader } from './loader';

/** Staff availability (docs/modules/reservations.md → API): the slots of one day for a party. */
@RequireFeature('reservations')
@Controller('reservations')
export class AvailabilityController {
  constructor(
    private readonly loader: AvailabilityLoader,
    private readonly access: AccessService,
    private readonly clock: Clock,
  ) {}

  @RequirePermission('reservations.bookings.read')
  @Get('availability')
  async get(
    @Query(new ZodQuery(reservationAvailabilityQuerySchema)) query: ReservationAvailabilityQuery,
  ): Promise<ReservationAvailabilityResponse> {
    // A location the caller can't read bookings at doesn't exist for them (404, like unknown ids).
    const scope = await this.access.locationIdsFor('reservations.bookings.read');
    if (scope !== 'all' && !scope.includes(query.locationId)) {
      throw reservationErrors.locationNotFound();
    }
    return this.loader.load({ ...query, channel: 'staff', now: this.clock.now() });
  }
}
