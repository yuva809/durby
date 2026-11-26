import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import {
  type BookingPage,
  type BookingPageQuery,
  bookingPageQuerySchema,
  type BookingPageResponse,
  type PutBookingPageRequest,
  putBookingPageRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../../platform/http';
import { Idempotent } from '../../../platform/idempotency';
import { RequirePermission } from '../../../platform/rbac';
import { BookingPagesService } from './booking-pages.service';

/**
 * The online booking page's setup (docs/modules/reservations.md → R2.1). The page answers guests only with
 * `reservations.online`; setting it up needs `reservations` (the response says whether it's online).
 */
@RequireFeature('reservations')
@Controller('reservations/booking-page')
export class BookingPagesController {
  constructor(private readonly pages: BookingPagesService) {}

  @RequirePermission('reservations.bookings.read')
  @Get()
  get(
    @Query(new ZodQuery(bookingPageQuerySchema)) query: BookingPageQuery,
  ): Promise<BookingPageResponse> {
    return this.pages.get(query.locationId);
  }

  @RequirePermission('reservations.setup.edit')
  @Idempotent()
  @Put()
  put(
    @Body(new ZodBody(putBookingPageRequestSchema)) body: PutBookingPageRequest,
  ): Promise<BookingPage> {
    return this.pages.put(body);
  }
}
