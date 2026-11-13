import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  type CreateReservationRequest,
  createReservationRequestSchema,
  type CreateWalkInRequest,
  createWalkInRequestSchema,
  type SeatReservationRequest,
  seatReservationRequestSchema,
  type UndoReservationRequest,
  undoReservationRequestSchema,
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
import { ReservationsBusyInterceptor } from './busy';
import { BookingStatusService } from './status.service';

const reservationId = () =>
  new ParseUUIDPipe({ exceptionFactory: reservationErrors.reservationNotFound });

/**
 * Staff bookings (docs/modules/reservations.md → R1.6 bookings API). The guard checks the key at
 * any location; the service checks it at the booking's location.
 */
@RequireFeature('reservations')
@UseInterceptors(ReservationsBusyInterceptor)
@Controller('reservations')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly status: BookingStatusService,
  ) {}

  @RequirePermission('reservations.bookings.read')
  @Get()
  async list(
    @Query(new ZodQuery(reservationsListQuerySchema)) query: ReservationsListQuery,
  ): Promise<ReservationsListResponse> {
    return { data: await this.bookings.list(query) };
  }

  @RequirePermission('reservations.bookings.create')
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

  @RequirePermission('reservations.bookings.edit')
  @Idempotent()
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: reservationErrors.reservationNotFound }))
    id: string,
    @Body(new ZodBody(updateReservationRequestSchema)) body: UpdateReservationRequest,
  ): Promise<Reservation> {
    return this.bookings.update(id, body);
  }

  // Status actions (R1.6c): each appends a status change.

  @RequirePermission('reservations.bookings.create')
  @Idempotent({ completion: 'transaction' })
  @Post('walk-ins')
  walkIn(
    @Body(new ZodBody(createWalkInRequestSchema)) body: CreateWalkInRequest,
  ): Promise<Reservation> {
    return this.status.walkIn(body);
  }

  @RequirePermission('reservations.bookings.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/arrive')
  arrive(@Param('id', reservationId()) id: string): Promise<Reservation> {
    return this.status.act(id, 'arrive');
  }

  @RequirePermission('reservations.bookings.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/seat')
  seat(
    @Param('id', reservationId()) id: string,
    @Body(new ZodBody(seatReservationRequestSchema)) body: SeatReservationRequest,
  ): Promise<Reservation> {
    return this.status.act(id, 'seat', body);
  }

  @RequirePermission('reservations.bookings.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/finish')
  finish(@Param('id', reservationId()) id: string): Promise<Reservation> {
    return this.status.act(id, 'finish');
  }

  @RequirePermission('reservations.bookings.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/no-show')
  noShow(@Param('id', reservationId()) id: string): Promise<Reservation> {
    return this.status.act(id, 'no_show');
  }

  @RequirePermission('reservations.bookings.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/cancel')
  cancel(@Param('id', reservationId()) id: string): Promise<Reservation> {
    return this.status.act(id, 'cancel');
  }

  @RequirePermission('reservations.bookings.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/undo')
  undo(
    @Param('id', reservationId()) id: string,
    @Body(new ZodBody(undoReservationRequestSchema)) body: UndoReservationRequest,
  ): Promise<Reservation> {
    return this.status.undo(id, body.changeId);
  }
}
