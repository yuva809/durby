import { AllowDuringPasswordChange, IdempotencyExempt } from '../markers';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ACCOUNT_SLOT_HEADER,
  changePasswordRequestSchema,
  updateMeRequestSchema,
  type UpdateMeRequest,
  type ChangePasswordRequest,
  emailRequestSchema,
  type EmailRequest,
  loginRequestSchema,
  type LoginRequest,
  type MeResponse,
  resetPasswordRequestSchema,
  type ResetPasswordRequest,
  type SessionResponse,
  switchOrganizationRequestSchema,
  type SwitchOrganizationRequest,
  verifyEmailRequestSchema,
  type VerifyEmailRequest,
} from '@durby/shared';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import { ApiError, ZodBody } from '../http';
import { AuthContext } from './auth-context';
import { Authenticated } from '../markers';
import {
  accountSlot,
  clearRefreshCookieOptions,
  refreshCookieName,
  refreshCookieOptions,
} from './cookies';
import { RequireOrigin } from './origin.guard';
import { PasswordService } from './password.service';
import { Public } from '../markers';
import { type IssuedSession, SessionService } from './session.service';

/** ADR 0006 §12: rotation can't be replayed by design, and stored responses would hold tokens. */
const AUTH_EXEMPT = 'auth route (ADR 0006 §12)';
/**
 * /api/v1/auth (docs/platform/auth.md → Endpoints). Exempt from Idempotency-Key (ADR 0006):
 * refresh rotation cannot be replayed and stored responses would persist tokens.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthContext,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body(new ZodBody(loginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    // The host picks which organizations the session offers (ADR 0042).
    const name = this.cookieName(req);
    return this.respond(res, name, await this.sessions.login(body, clientIp(req), req.hostname));
  }

  @Public()
  @RequireOrigin()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const name = this.cookieName(req);
    return this.respond(
      res,
      name,
      await this.clearCookieOnFailure(res, name, () =>
        this.sessions.refresh(this.cookie(req, name), clientIp(req), req.hostname),
      ),
    );
  }

  /** Public, authenticated by its cookie: logging out must work after the access token expired. */
  @Public()
  @RequireOrigin()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const name = this.cookieName(req);
    await this.sessions.logout(this.cookie(req, name), clientIp(req));
    res.clearCookie(name, clearRefreshCookieOptions(this.config));
  }

  @Authenticated()
  @RequireOrigin()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('switch-organization')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async switchOrganization(
    @Body(new ZodBody(switchOrganizationRequestSchema)) body: SwitchOrganizationRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const name = this.cookieName(req);
    const session = await this.sessions.switchOrganization(
      this.auth.require(),
      body.organizationId,
      this.cookie(req, name),
      clientIp(req),
      req.hostname,
    );
    return this.respond(res, name, session);
  }

  @Authenticated()
  @AllowDuringPasswordChange()
  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@Req() req: Request): Promise<MeResponse> {
    return this.sessions.me(this.auth.require(), req.hostname);
  }

  /** Your own language (UI and mails); setting the same one twice changes nothing. */
  @Authenticated()
  @IdempotencyExempt('sets one value: replaying it changes nothing')
  @Patch('me')
  @Header('Cache-Control', 'no-store')
  updateMe(
    @Body(new ZodBody(updateMeRequestSchema)) body: UpdateMeRequest,
    @Req() req: Request,
  ): Promise<MeResponse> {
    return this.sessions.updateMe(this.auth.require(), body, req.hostname);
  }

  /** Your own password; the one route a temporary-password session may use (ADR 0023 §3). */
  @Authenticated()
  @AllowDuringPasswordChange()
  @RequireOrigin()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('password/change')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @Body(new ZodBody(changePasswordRequestSchema)) body: ChangePasswordRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return this.respond(
      res,
      this.cookieName(req),
      await this.sessions.changePassword(this.auth.require(), body, clientIp(req), req.hostname),
    );
  }

  @Public()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(
    @Body(new ZodBody(emailRequestSchema)) body: EmailRequest,
    @Req() req: Request,
  ): Promise<void> {
    // The Origin only picks which of our own sites the link opens on (ADR 0041); anything else gets WEB_BASE_URL.
    await this.passwords.requestPasswordReset(body.email, clientIp(req), req.headers.origin);
  }

  @Public()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Body(new ZodBody(resetPasswordRequestSchema)) body: ResetPasswordRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.passwords.resetPassword(body.token, body.password, clientIp(req));
  }

  @Public()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyEmail(
    @Body(new ZodBody(verifyEmailRequestSchema)) body: VerifyEmailRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.passwords.verifyEmail(body.token, clientIp(req));
  }

  @Public()
  @IdempotencyExempt(AUTH_EXEMPT)
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(
    @Body(new ZodBody(emailRequestSchema)) body: EmailRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.passwords.resendVerification(body.email, clientIp(req), req.headers.origin);
  }

  /** The refresh cookie of the request's account slot (ACCOUNT_SLOT_HEADER, ADR 0047). */
  private cookieName(req: Request): string {
    const slot = accountSlot(req.headers[ACCOUNT_SLOT_HEADER.toLowerCase()]);
    if (slot === null) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'validation.failed', 'Invalid account slot.');
    }
    return refreshCookieName(this.config, slot);
  }

  private cookie(req: Request, name: string): string | undefined {
    const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private respond(res: Response, name: string, session: IssuedSession): SessionResponse {
    res.cookie(
      name,
      session.refresh.token,
      refreshCookieOptions(this.config, session.refresh.expiresAt),
    );
    return session.body;
  }

  /** A dead refresh cookie is removed, so the browser stops sending it. */
  private async clearCookieOnFailure<T>(
    res: Response,
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'auth.refresh_invalid' || error.code === 'auth.refresh_reused')
      ) {
        res.clearCookie(name, clearRefreshCookieOptions(this.config));
      }
      throw error;
    }
  }
}

/** Client address as Express resolves it with `trust proxy` (TRUST_PROXY hops). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
