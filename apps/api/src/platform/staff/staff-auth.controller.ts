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
  type StaffCodeRequest,
  staffCodeRequestSchema,
  type StaffEnrollResponse,
  type StaffLoginRequest,
  staffLoginRequestSchema,
  type StaffLoginResponse,
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
 * /api/v1/platform/auth (docs/platform/admin-portal.md → API). The pre-session steps are
 * @Public() and authenticated by the pending session cookie; the rest is @PlatformOnly.
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
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body(new ZodBody(staffLoginRequestSchema)) body: StaffLoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffLoginResponse> {
    const result = await this.sessions.login(body, clientIp(req));
    this.setCookie(res, result.session);
    return result.body;
  }

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async accept(
    @Body(new ZodBody(staffAcceptRequestSchema)) body: StaffAcceptRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffLoginResponse> {
    const result = await this.sessions.accept(body.token, body.password, clientIp(req));
    this.setCookie(res, result.session);
    return result.body;
  }

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  enroll(@Req() req: Request): Promise<StaffEnrollResponse> {
    return this.sessions.enroll(staffCookie(req, this.config));
  }

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('enroll/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmEnrollment(
    @Body(new ZodBody(staffCodeRequestSchema)) body: StaffCodeRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.setCookie(
      res,
      await this.sessions.confirmEnrollment(staffCookie(req, this.config), body.code),
    );
  }

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(STAFF_AUTH_EXEMPT)
  @Post('totp')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyCode(
    @Body(new ZodBody(staffCodeRequestSchema)) body: StaffCodeRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.setCookie(res, await this.sessions.verifyCode(staffCookie(req, this.config), body.code));
  }

  /** Public, authenticated by its cookie: logging out works in any session state. */
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
    return this.sessions.reauth(this.staff.require(), body.password, body.code);
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
