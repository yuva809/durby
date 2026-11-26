import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import {
  type PublicAvailability,
  type PublicAvailabilityQuery,
  publicAvailabilityQuerySchema,
  type PublicBookingPage,
} from '@durby/shared';
import type { Request } from 'express';
import { Public } from '../../../platform/auth';
import { ZodQuery } from '../../../platform/http';
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
}

/** Client address as Express resolves it with `trust proxy` (TRUST_PROXY hops). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
