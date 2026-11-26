import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  type ManageBooking,
  type PublicBooking,
  type PublicBookingRequest,
  publicBookingRequestSchema,
  type PublicRequestRequest,
  publicRequestSchema,
} from '@durby/shared';
import type { Request } from 'express';
import { Public } from '../../../platform/auth';
import { ZodBody } from '../../../platform/http';
import { IdempotencyExempt } from '../../../platform/markers';
import { OnlineReservationsService } from './online-reservations.service';

/**
 * A guest's booking and its manage link (docs/modules/reservations.md → R2.3a). No session: the hold names the slot,
 * the manage token (in `Authorization: Bearer`, read by the page from the URL fragment) names the booking.
 */
@Controller('public/booking')
export class OnlineReservationsController {
  constructor(private readonly online: OnlineReservationsService) {}

  @Public()
  @IdempotencyExempt(
    'a hold books once; the same hold again returns the same answer for 15 minutes',
  )
  @Post(':slug/reservations')
  @Header('Cache-Control', 'no-store')
  book(
    @Param('slug') slug: string,
    @Body(new ZodBody(publicBookingRequestSchema)) body: PublicBookingRequest,
    @Req() req: Request,
  ): Promise<PublicBooking> {
    return this.online.book(slug, body, req.hostname, clientIp(req));
  }

  @Public()
  @IdempotencyExempt('the same request again returns the same answer for 15 minutes')
  @Post(':slug/requests')
  @Header('Cache-Control', 'no-store')
  request(
    @Param('slug') slug: string,
    @Body(new ZodBody(publicRequestSchema)) body: PublicRequestRequest,
    @Req() req: Request,
  ): Promise<PublicBooking> {
    return this.online.request(slug, body, req.hostname, clientIp(req));
  }

  @Public()
  @Get('manage')
  @Header('Cache-Control', 'no-store')
  view(@Req() req: Request): Promise<ManageBooking> {
    return this.online.view(bearer(req), req.hostname, clientIp(req));
  }

  @Public()
  @IdempotencyExempt('cancelling twice answers the same, nothing changes again')
  @Post('manage/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(@Req() req: Request): Promise<ManageBooking> {
    return this.online.cancel(bearer(req), req.hostname, clientIp(req));
  }
}

function bearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** Client address as Express resolves it with `trust proxy` (TRUST_PROXY hops). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
