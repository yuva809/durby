import { type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TenantContext } from '../tenancy';
import { AccessTokenService, InvalidAccessTokenError } from './access-token.service';
import { AuthContext } from './auth-context';
import { authErrors } from './auth-errors';
import { Clock } from './clock';
import { RevocationService, RevocationUnavailableError } from './revocation.service';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * Verifies the request's access token and fills AuthContext and, when the token has an active
 * organization, TenantContext, into the request's CLS scope (opened around the whole request by
 * the TenancyModule middleware, so the handler and its lazy queries run inside it). The tenant
 * comes from the verified token only, never from the request.
 *
 * Called by the global AccessGuard (platform/rbac) for every route that isn't @Public().
 */
@Injectable()
export class Authenticator {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly revocations: RevocationService,
    private readonly authContext: AuthContext,
    private readonly tenantContext: TenantContext,
    private readonly clock: Clock,
  ) {}

  /** Throws 401 auth.unauthenticated (or 503 auth.unavailable) unless the token is valid. */
  async authenticate(context: ExecutionContext): Promise<void> {
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
      passwordChangeRequired: claims.passwordChangeRequired === true,
    });
    if (claims.organizationId !== null) {
      this.tenantContext.set({ tenantId: claims.organizationId, userId: claims.userId });
    }
  }
}
