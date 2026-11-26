import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type CreateHoldRequest,
  createHoldRequestSchema,
  type Hold,
  type PublicAvailability,
  type PublicAvailabilityQuery,
  publicAvailabilityQuerySchema,
  type PublicBookingPage,
} from '@durby/shared';
import type { Request } from 'express';
import { Public } from '../../../platform/auth';
import { ZodBody, ZodQuery } from '../../../platform/http';
import { IdempotencyExempt } from '../../../platform/markers';
import { reservationErrors } from '../reservations-errors';
import { PublicBookingService } from './public-booking.service';

/**
 * The public booking page's reads (docs/modules/reservations.md → R2.1, ADR 0085): no session, the slug names the
 * page. The service checks the feature, the page and the domain itself (`@RequireFeature` can't sit next to
 * `@Public`). Booking itself comes in R2.3.
 */
@Controller('public/booking')
export class PublicBookingController {
  constructor(private readonly booking: PublicBookingService) {}

  @Public()
  @Get(':slug')
  @Header('Cache-Control', 'no-store')
  page(@Param('slug') slug: string, @Req() req: Request): Promise<PublicBookingPage> {
    return this.booking.page(slug, req.hostname, clientIp(req));
  }

  @Public()
  @Get(':slug/availability')
  @Header('Cache-Control', 'no-store')
  availability(
    @Param('slug') slug: string,
    @Query(new ZodQuery(publicAvailabilityQuerySchema)) query: PublicAvailabilityQuery,
    @Req() req: Request,
  ): Promise<PublicAvailability> {
    return this.booking.availability(slug, query, req.hostname, clientIp(req));
  }

  @Public()
  @IdempotencyExempt('hold replaced by key, expires by TTL')
  @Post(':slug/holds')
  @Header('Cache-Control', 'no-store')
  hold(
    @Param('slug') slug: string,
    @Body(new ZodBody(createHoldRequestSchema)) body: CreateHoldRequest,
    @Req() req: Request,
  ): Promise<Hold> {
    return this.booking.hold(slug, body, req.hostname, clientIp(req));
  }

  @Public()
  @IdempotencyExempt('deleting a hold twice is a no-op')
  @Delete(':slug/holds/:holdId')
  @HttpCode(204)
  async release(
    @Param('slug') slug: string,
    @Param('holdId', new ParseUUIDPipe({ exceptionFactory: reservationErrors.holdNotFound }))
    holdId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.booking.release(slug, holdId, req.hostname, clientIp(req));
  }
}

/** Client address as Express resolves it with `trust proxy` (TRUST_PROXY hops). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
