import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  type CreateWaitlistEntryRequest,
  createWaitlistEntryRequestSchema,
  type NotifyWaitlistEntryRequest,
  notifyWaitlistEntryRequestSchema,
  type SeatWaitlistEntryRequest,
  seatWaitlistEntryRequestSchema,
  type SeatWaitlistEntryResponse,
  type UpdateWaitlistEntryRequest,
  updateWaitlistEntryRequestSchema,
  type WaitlistEntry,
  type WaitlistQuery,
  waitlistQuerySchema,
  type WaitlistResponse,
} from '@durby/shared';
import { RequireFeature } from '../../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../../platform/http';
import { Idempotent } from '../../../platform/idempotency';
import { RequirePermission } from '../../../platform/rbac';
import { ReservationsBusyInterceptor } from '../bookings/busy';
import { reservationErrors } from '../reservations-errors';
import { WaitlistService } from './waitlist.service';

const entryId = () =>
  new ParseUUIDPipe({ exceptionFactory: reservationErrors.waitlistEntryNotFound });

/**
 * The waitlist (docs/modules/reservations.md → Waitlist). The guard checks the key at any location;
 * the service checks it at the entry's location.
 */
@RequireFeature('reservations')
@UseInterceptors(ReservationsBusyInterceptor)
@Controller('reservations/waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @RequirePermission('reservations.bookings.read')
  @Get()
  list(@Query(new ZodQuery(waitlistQuerySchema)) query: WaitlistQuery): Promise<WaitlistResponse> {
    return this.waitlist.list(query.locationId);
  }

  @RequirePermission('reservations.waitlist.create')
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(createWaitlistEntryRequestSchema)) body: CreateWaitlistEntryRequest,
  ): Promise<WaitlistEntry> {
    return this.waitlist.create(body);
  }

  @RequirePermission('reservations.waitlist.edit')
  @Idempotent({ completion: 'transaction' })
  @Patch(':id')
  update(
    @Param('id', entryId()) id: string,
    @Body(new ZodBody(updateWaitlistEntryRequestSchema)) body: UpdateWaitlistEntryRequest,
  ): Promise<WaitlistEntry> {
    return this.waitlist.update(id, body);
  }

  @RequirePermission('reservations.waitlist.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/notify')
  notify(
    @Param('id', entryId()) id: string,
    @Body(new ZodBody(notifyWaitlistEntryRequestSchema)) body: NotifyWaitlistEntryRequest,
  ): Promise<WaitlistEntry> {
    return this.waitlist.notify(id, body);
  }

  @RequirePermission('reservations.waitlist.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/seat')
  seat(
    @Param('id', entryId()) id: string,
    @Body(new ZodBody(seatWaitlistEntryRequestSchema)) body: SeatWaitlistEntryRequest,
  ): Promise<SeatWaitlistEntryResponse> {
    return this.waitlist.seat(id, body);
  }

  @RequirePermission('reservations.waitlist.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/leave')
  leave(@Param('id', entryId()) id: string): Promise<WaitlistEntry> {
    return this.waitlist.leave(id);
  }

  @RequirePermission('reservations.waitlist.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/return')
  return(@Param('id', entryId()) id: string): Promise<WaitlistEntry> {
    return this.waitlist.return(id);
  }

  @RequirePermission('reservations.waitlist.delete')
  @Idempotent({ completion: 'transaction' })
  @Delete(':id')
  remove(@Param('id', entryId()) id: string): Promise<WaitlistEntry> {
    return this.waitlist.remove(id);
  }
}
