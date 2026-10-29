import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  type StaffAcceptRequest,
  staffAcceptRequestSchema,
  type StaffLoginRequest,
  staffLoginRequestSchema,
  type StaffMeResponse,
  type StaffReauthRequest,
  staffReauthRequestSchema,
} from '@durby/shared';
import type { Request, Response } from 'express';
import { RequireOrigin } from '../auth';
import { APP_CONFIG, type AppConfig } from '../config';
import { ZodBody } from '../http';
import { IdempotencyExempt, PlatformOnly, Public } from '../markers';
import { StaffContext } from './staff-context';
import { staffCookie, staffCookieName, staffCookieOptions } from './staff-cookies';
import { type IssuedStaffSession, StaffSessionsService } from './staff-sessions.service';

/** Like ADR 0006 §12: sessions can't be replayed by design, and stored responses would hold tokens. */
const STAFF_AUTH_EXEMPT = 'staff auth route (ADR 0017 §8)';

/**
 * /api/v1/platform/auth (docs/platform/admin-portal.md → API). Sign-in and invitation acceptance
 * are @Public() and set the session cookie; the rest is @PlatformOnly.
 */
@Controller('platform/auth')
export class StaffAuthController {
  constructor(
    private readonly sessions: StaffSessionsService,
    private readonly staff: StaffContext,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('login')
  @HttpCode(HttpStatus.NO_CONTENT)
  async login(
    @Body(new ZodBody(staffLoginRequestSchema)) body: StaffLoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.setCookie(res, await this.sessions.login(body, clientIp(req)));
  }

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  async accept(
    @Body(new ZodBody(staffAcceptRequestSchema)) body: StaffAcceptRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.setCookie(res, await this.sessions.accept(body.token, body.password, clientIp(req)));
  }

  /** Public, authenticated by its cookie: logging out works whatever the session's state. */
  @Public()
  @RequireOrigin()
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.logout(staffCookie(req, this.config), clientIp(req));
    res.clearCookie(staffCookieName(this.config), staffCookieOptions(this.config));
  }

  @PlatformOnly('staff.portal.access')
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('reauth')
  @HttpCode(HttpStatus.NO_CONTENT)
  reauth(@Body(new ZodBody(staffReauthRequestSchema)) body: StaffReauthRequest): Promise<void> {
    return this.sessions.reauth(this.staff.require(), body.password);
  }

  @PlatformOnly('staff.portal.access')
  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(): Promise<StaffMeResponse> {
    return this.sessions.me(this.staff.require());
  }

  private setCookie(res: Response, session: IssuedStaffSession): void {
    res.cookie(
      staffCookieName(this.config),
      session.token,
      staffCookieOptions(this.config, session.expiresAt),
    );
  }
}

/** Client address as Express resolves it with `trust proxy` (TRUST_PROXY hops). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
