import { Controller, Param, ParseUUIDPipe, Post, UseInterceptors } from '@nestjs/common';
import type { AnonymiseGuestResponse } from '@durby/shared';
import { RequireFeature } from '../../../platform/config/entitlements';
import { Idempotent } from '../../../platform/idempotency';
import { RequirePermission } from '../../../platform/rbac';
import { reservationErrors } from '../reservations-errors';
import { ReservationsBusyInterceptor } from './busy';
import { GuestsService } from './guests.service';

/**
 * Reservation guests (docs/modules/reservations.md → GDPR). The guard checks the key at any
 * location; the service checks it at every location the guest has bookings at.
 */
@RequireFeature('reservations')
@UseInterceptors(ReservationsBusyInterceptor)
@Controller('reservations/guests')
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @RequirePermission('reservations.setup.manage')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/anonymise')
  anonymise(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: reservationErrors.guestNotFound }))
    id: string,
  ): Promise<AnonymiseGuestResponse> {
    return this.guests.anonymise(id);
  }
}
