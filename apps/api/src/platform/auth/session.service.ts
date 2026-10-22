import { Injectable } from '@nestjs/common';
import type { MeResponse, OrganizationSummary, SessionResponse } from '@durby/shared';
import { PrismaService } from '../database';
import { AccessTokenService } from './access-token.service';
import type { AuthContextValue } from './auth-context';
import { authErrors } from './auth-errors';
import { AUTH_RATE_LIMITS, AuthRateLimits } from './auth-rate-limits';
import { Clock } from './clock';
import { emailKey, normalizeEmail } from './crypto';
import { LockoutService, LockoutUnavailableError } from './lockout.service';
import { MembershipLookup } from './membership-lookup';
import { PasswordHasher } from './password-hasher';
import type { IssuedRefreshToken, RefreshSession } from './refresh-token.store';
import { RefreshTokenStore } from './refresh-token.store';
import { RevocationService } from './revocation.service';
import { SecurityLog } from './security-log';

/** A session response plus the refresh token for the cookie (never in the body). */
export interface IssuedSession {
  body: SessionResponse;
  refresh: IssuedRefreshToken;
}

/** Login, refresh, logout and organization switch (docs/platform/auth.md). */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly lockout: LockoutService,
    private readonly limits: AuthRateLimits,
    private readonly memberships: MembershipLookup,
    private readonly refreshTokens: RefreshTokenStore,
    private readonly accessTokens: AccessTokenService,
    private readonly revocations: RevocationService,
    private readonly security: SecurityLog,
    private readonly clock: Clock,
  ) {}

  async login(input: { email: string; password: string }, ip: string): Promise<IssuedSession> {
    const key = emailKey(input.email);
    await this.limits.enforce([AUTH_RATE_LIMITS.loginIp, ip], [AUTH_RATE_LIMITS.loginEmail, key]);

    const lock = await this.lockoutCall(() => this.lockout.check(key));
    if (lock.locked) {
      this.security.event('auth.login.locked', { emailKey: key, ip });
      throw authErrors.tooManyAttempts(lock.retryAfterSeconds);
    }

    const user = await this.db.user.findUnique({ where: { email: normalizeEmail(input.email) } });
    // Same work for unknown users and users without a password (dummy hash): no enumeration.
    const valid = await this.hasher.verify(user?.passwordHash ?? null, input.password);
    if (!user || !valid) {
      await this.lockoutCall(() => this.lockout.recordFailure(key));
      this.security.event('auth.login.failed', { userId: user?.id, emailKey: key, ip });
      throw authErrors.invalidCredentials();
    }
    await this.lockoutCall(() => this.lockout.reset(key));
    if (user.emailVerifiedAt === null) throw authErrors.emailNotVerified();

    const organizations = await this.memberships.organizationsOf(user.id);
    const active =
      organizations.find((org) => org.id === user.lastOrganizationId) ?? organizations[0] ?? null;
    const refresh = await this.refreshTokens.startFamily(user.id, active?.id ?? null);
    this.security.event('auth.login.succeeded', {
      userId: user.id,
      sessionId: refresh.familyId,
      organizationId: active?.id ?? null,
      ip,
    });
    return this.issue(user.id, active?.id ?? null, refresh, organizations);
  }

  /** Rotates the refresh token; the organization is kept only while the user is still a member. */
  async refresh(token: string | undefined, ip: string): Promise<IssuedSession> {
    await this.limits.enforce([AUTH_RATE_LIMITS.refreshIp, ip]);
    if (!token) throw authErrors.refreshInvalid();
    const result = await this.refreshTokens.rotate(token, async (session) =>
      session.organizationId !== null &&
      (await this.memberships.isMember(session.userId, session.organizationId))
        ? session.organizationId
        : null,
    );
    return this.afterRotation(result, ip);
  }

  /** Ends the cookie's session, whatever state its token is in. Idempotent. */
  async logout(token: string | undefined, ip: string): Promise<void> {
    if (!token) return;
    const family = await this.refreshTokens.familyOf(token);
    if (!family) return;
    await this.refreshTokens.revokeFamily(family.familyId, 'logout');
    await this.revocationCall(() => this.revocations.revokeSession(family.familyId));
    this.security.event('auth.logout', { userId: family.userId, sessionId: family.familyId, ip });
  }

  /**
   * Switches the active organization of the caller's session. Membership is checked before the
   * refresh token is touched, so a 403 leaves the session as it was.
   */
  async switchOrganization(
    auth: Readonly<AuthContextValue>,
    organizationId: string,
    token: string | undefined,
    ip: string,
  ): Promise<IssuedSession> {
    if (!(await this.memberships.isMember(auth.userId, organizationId))) {
      throw authErrors.notAMember();
    }
    if (!token) throw authErrors.refreshInvalid();
    const result = await this.refreshTokens.rotate(token, () => Promise.resolve(organizationId), {
      userId: auth.userId,
      familyId: auth.sessionId,
    });
    const session = await this.afterRotation(result, ip);
    await this.db.user.update({
      where: { id: auth.userId },
      data: { lastOrganizationId: organizationId },
    });
    this.security.event('auth.organization.switched', {
      userId: auth.userId,
      sessionId: auth.sessionId,
      organizationId,
      ip,
    });
    return session;
  }

  async me(auth: Readonly<AuthContextValue>): Promise<MeResponse> {
    const user = await this.db.user.findUnique({ where: { id: auth.userId } });
    if (!user) throw authErrors.unauthenticated();
    return {
      user: { id: user.id, email: user.email, locale: user.locale },
      organizations: await this.memberships.organizationsOf(user.id),
      activeOrganizationId: auth.organizationId,
    };
  }

  private async afterRotation(
    result: Awaited<ReturnType<RefreshTokenStore['rotate']>>,
    ip: string,
  ): Promise<IssuedSession> {
    if (result.kind === 'invalid') throw authErrors.refreshInvalid();
    if (result.kind === 'reused') {
      await this.revokeReusedFamily(result.session, ip);
      throw authErrors.refreshReused();
    }
    return this.issue(result.session.userId, result.session.organizationId, result.next);
  }

  private async revokeReusedFamily(session: RefreshSession, ip: string): Promise<void> {
    await this.refreshTokens.revokeFamily(session.familyId, 'reuse_detected');
    await this.revocationCall(() => this.revocations.revokeSession(session.familyId));
    this.security.event('auth.refresh.reuse_detected', {
      userId: session.userId,
      sessionId: session.familyId,
      ip,
    });
  }

  private async issue(
    userId: string,
    organizationId: string | null,
    refresh: IssuedRefreshToken,
    organizations?: OrganizationSummary[],
  ): Promise<IssuedSession> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const accessToken = await this.accessTokens.sign(
      { userId, organizationId, sessionId: refresh.familyId },
      this.clock.now(),
    );
    return {
      refresh,
      body: {
        accessToken,
        expiresIn: this.accessTokens.ttlSeconds,
        user: { id: user.id, email: user.email, locale: user.locale },
        organizations: organizations ?? (await this.memberships.organizationsOf(userId)),
        activeOrganizationId: organizationId,
      },
    };
  }

  private async lockoutCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof LockoutUnavailableError) throw authErrors.unavailable();
      throw error;
    }
  }

  private async revocationCall(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      throw authErrors.unavailable();
    }
  }
}
