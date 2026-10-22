import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TenantContext } from '../tenancy';
import { AccessTokenService, InvalidAccessTokenError } from './access-token.service';
import { AuthContext } from './auth-context';
import { authErrors } from './auth-errors';
import { Clock } from './clock';
import { IS_PUBLIC_KEY } from './public.decorator';
import { RevocationService, RevocationUnavailableError } from './revocation.service';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * Global guard: every route needs a valid access token unless it is @Public(). Fills AuthContext
 * and, when the token has an active organization, TenantContext, into the request's CLS scope
 * (opened around the whole request by the TenancyModule middleware, so the handler and its lazy
 * queries run inside it). The tenant comes from the verified token only, never from the request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly revocations: RevocationService,
    private readonly authContext: AuthContext,
    private readonly tenantContext: TenantContext,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const header = context.switchToHttp().getRequest<Request>().headers.authorization;
    const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
    if (token === undefined) throw authErrors.unauthenticated();

    let claims;
    try {
      claims = await this.tokens.verify(token, this.clock.now());
      if (await this.revocations.isRevoked(claims)) throw authErrors.unauthenticated();
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) throw authErrors.unauthenticated();
      if (error instanceof RevocationUnavailableError) throw authErrors.unavailable();
      throw error;
    }

    this.authContext.set({
      userId: claims.userId,
      organizationId: claims.organizationId,
      sessionId: claims.sessionId,
    });
    if (claims.organizationId !== null) {
      this.tenantContext.set({ tenantId: claims.organizationId, userId: claims.userId });
    }
    return true;
  }
}
