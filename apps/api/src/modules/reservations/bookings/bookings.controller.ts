import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  type CreateReservationRequest,
  createReservationRequestSchema,
  type Reservation,
  type ReservationDetail,
  type ReservationsListQuery,
  reservationsListQuerySchema,
  type ReservationsListResponse,
  type UpdateReservationRequest,
  updateReservationRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../../platform/http';
import { Idempotent } from '../../../platform/idempotency';
import { RequirePermission } from '../../../platform/rbac';
import { reservationErrors } from '../reservations-errors';
import { BookingsService } from './bookings.service';

/**
 * Staff bookings (docs/modules/reservations.md → R1.6 bookings API). The guard checks the key at
 * any location; the service checks it at the booking's location.
 */
@RequireFeature('reservations')
@Controller('reservations')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @RequirePermission('reservations.bookings.read')
  @Get()
  async list(
    @Query(new ZodQuery(reservationsListQuerySchema)) query: ReservationsListQuery,
  ): Promise<ReservationsListResponse> {
    return { data: await this.bookings.list(query) };
  }

  @RequirePermission('reservations.bookings.manage')
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(createReservationRequestSchema)) body: CreateReservationRequest,
  ): Promise<Reservation> {
    return this.bookings.create(body);
  }

  @RequirePermission('reservations.bookings.read')
  @Get(':id')
  get(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: reservationErrors.reservationNotFound }))
    id: string,
  ): Promise<ReservationDetail> {
    return this.bookings.get(id);
  }

  @RequirePermission('reservations.bookings.manage')
  @Idempotent()
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: reservationErrors.reservationNotFound }))
    id: string,
    @Body(new ZodBody(updateReservationRequestSchema)) body: UpdateReservationRequest,
  ): Promise<Reservation> {
    return this.bookings.update(id, body);
  }
}
