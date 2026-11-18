import { Inject, Injectable } from '@nestjs/common';
import type { MeResponse, OrganizationSummary, SessionResponse } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../audit';
import { PrismaService } from '../database';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';
import { AccessTokenService } from './access-token.service';
import {
  ACTIVE_ACCESS_LOOKUP,
  type ActiveAccess,
  type ActiveAccessLookup,
  NO_ACTIVE_ACCESS,
} from './active-access';
import type { AuthContextValue } from './auth-context';
import { authErrors } from './auth-errors';
import { AuthRateLimits } from './auth-rate-limits';
import { Clock } from './clock';
import { emailKey, normalizeEmail } from './crypto';
import { LockoutService, LockoutUnavailableError } from './lockout.service';
import { MembershipLookup, type OrganizationScope } from './membership-lookup';
import { PasswordHasher } from './password-hasher';
import { PasswordPolicy } from './password-policy';
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
    @Inject(ACTIVE_ACCESS_LOOKUP) private readonly activeAccess: ActiveAccessLookup,
    @Inject(TENANT_PRISMA) private readonly tenantDb: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly passwordPolicy: PasswordPolicy,
  ) {}

  /** `host`: the request's host; it picks which organizations the session offers (ADR 0042). */
  async login(
    input: { email: string; password: string },
    ip: string,
    host?: string,
  ): Promise<IssuedSession> {
    const key = emailKey(input.email);
    await this.limits.enforce([this.limits.rules.loginIp, ip], [this.limits.rules.loginEmail, key]);

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
    // An account an organization created with a temporary password may sign in before the email is
    // verified (ADR 0023 §3: vouched, not verified).
    if (user.emailVerifiedAt === null && user.vouchedByOrganizationId === null) {
      throw authErrors.emailNotVerified();
    }

    // Only the organizations of this site (ADR 0042): a partner's domain shows its organizations, the main site the
    // others. The last one used wins when it is among them.
    const scope = await this.memberships.scopeForHost(host);
    const organizations = await this.memberships.organizationsOf(user.id, scope);
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

  /**
   * Rotates the refresh token; the organization is kept only while the user is still a member. One of another site
   * (ADR 0042) is replaced by this site's last used or first organization.
   */
  async refresh(token: string | undefined, ip: string, host?: string): Promise<IssuedSession> {
    await this.limits.enforce([this.limits.rules.refreshIp, ip]);
    if (!token) throw authErrors.refreshInvalid();
    const scope = await this.memberships.scopeForHost(host);
    const result = await this.refreshTokens.rotate(token, async (session) => {
      if (
        session.organizationId === null ||
        !(await this.memberships.isMember(session.userId, session.organizationId))
      ) {
        return null;
      }
      return (await this.memberships.inScope(session.organizationId, scope))
        ? session.organizationId
        : this.siteDefault(session.userId, scope);
    });
    return this.afterRotation(result, ip, scope);
  }

  /** The site's organization to open: the last one used when it is among them, else the first (ADR 0042). */
  private async siteDefault(userId: string, scope: OrganizationScope): Promise<string | null> {
    const [user, organizations] = await Promise.all([
      this.db.user.findUnique({ where: { id: userId }, select: { lastOrganizationId: true } }),
      this.memberships.organizationsOf(userId, scope),
    ]);
    return (
      organizations.find((org) => org.id === user?.lastOrganizationId)?.id ??
      organizations[0]?.id ??
      null
    );
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
    host?: string,
  ): Promise<IssuedSession> {
    // Another site's organization is switched to on that site (ADR 0042): answered like a non-member.
    const scope = await this.memberships.scopeForHost(host);
    if (
      !(await this.memberships.isMember(auth.userId, organizationId)) ||
      !(await this.memberships.inScope(organizationId, scope))
    ) {
      throw authErrors.notAMember();
    }
    if (!token) throw authErrors.refreshInvalid();
    const result = await this.refreshTokens.rotate(token, () => Promise.resolve(organizationId), {
      userId: auth.userId,
      familyId: auth.sessionId,
    });
    const session = await this.afterRotation(result, ip, scope);
    // Audited in the organization switched to (ADR 0008 §8), with the remembered organization.
    await this.tenantContext.run({ tenantId: organizationId, userId: auth.userId }, () =>
      this.tenantDb.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: auth.userId },
          data: { lastOrganizationId: organizationId },
        });
        await this.audit.record(tx, {
          action: 'platform.session.organization_switched',
          actor: auditActor.user(auth.userId),
          entityId: auth.sessionId,
          before: snapshot('session', { organizationId: auth.organizationId }),
          after: snapshot('session', {
            organizationId,
            previousOrganizationId: auth.organizationId,
          }),
        });
      }),
    );
    return session;
  }

  /** `host`: the request's host; the organization list is this site's (ADR 0042). */
  async me(auth: Readonly<AuthContextValue>, host?: string): Promise<MeResponse> {
    const user = await this.db.user.findUnique({ where: { id: auth.userId } });
    if (!user) throw authErrors.unauthenticated();
    const changeRequired = await this.passwordPolicy.changeRequired(user);
    return {
      user: { id: user.id, email: user.email, locale: user.locale },
      organizations: await this.memberships.organizationsOf(
        user.id,
        await this.memberships.scopeForHost(host),
      ),
      activeOrganizationId: auth.organizationId,
      ...(await this.accessIn(auth.organizationId, user.id)),
      passwordChangeRequired: changeRequired,
    };
  }

  /** Sets the caller's own language (users row only); the answer is GET /me's. */
  async updateMe(
    auth: Readonly<AuthContextValue>,
    body: { locale: string },
    host?: string,
  ): Promise<MeResponse> {
    const { count } = await this.db.user.updateMany({
      where: { id: auth.userId },
      data: { locale: body.locale },
    });
    if (count === 0) throw authErrors.unauthenticated();
    // A user-level change: no organization's audit log holds it, the security log does (like a
    // password change).
    this.security.event('auth.locale.changed', {
      userId: auth.userId,
      sessionId: auth.sessionId,
      locale: body.locale,
    });
    return this.me(auth, host);
  }

  /**
   * Changes the caller's password (and a temporary one, ADR 0023 §3): checks the current password,
   * clears `must_change_password`, ends every session of the user and starts a new one for this
   * caller in the same organization.
   */
  async changePassword(
    auth: Readonly<AuthContextValue>,
    input: { currentPassword: string; newPassword: string },
    ip: string,
    host?: string,
  ): Promise<IssuedSession> {
    await this.limits.enforce([this.limits.rules.loginIp, ip]);
    const user = await this.db.user.findUnique({ where: { id: auth.userId } });
    if (!user) throw authErrors.unauthenticated();
    // Set by an owner or admin (ADR 0052): not the person's to change.
    if (await this.passwordPolicy.managed(user)) throw authErrors.passwordManaged();
    if (!(await this.hasher.verify(user.passwordHash, input.currentPassword))) {
      this.security.event('auth.login.failed', { userId: user.id, ip });
      throw authErrors.invalidCredentials();
    }
    const passwordHash = await this.hasher.hash(input.newPassword);
    const now = this.clock.now();
    await this.db.$transaction([
      this.db.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'password_reset' },
      }),
      this.db.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: now, mustChangePassword: false },
      }),
    ]);
    // Access tokens issued before this second stop working; the new session's token is issued now.
    await this.revocationCall(() => this.revocations.revokeUser(user.id, now));
    this.security.event('auth.password.changed', {
      userId: user.id,
      sessionId: auth.sessionId,
      ip,
    });
    const scope = await this.memberships.scopeForHost(host);
    const organizationId =
      auth.organizationId !== null &&
      (await this.memberships.isMember(user.id, auth.organizationId))
        ? auth.organizationId
        : null;
    const refresh = await this.refreshTokens.startFamily(user.id, organizationId);
    return this.issue(
      user.id,
      organizationId,
      refresh,
      await this.memberships.organizationsOf(user.id, scope),
    );
  }

  private async afterRotation(
    result: Awaited<ReturnType<RefreshTokenStore['rotate']>>,
    ip: string,
    scope: OrganizationScope,
  ): Promise<IssuedSession> {
    if (result.kind === 'invalid') throw authErrors.refreshInvalid();
    if (result.kind === 'reused') {
      await this.revokeReusedFamily(result.session, ip);
      throw authErrors.refreshReused();
    }
    if (result.recovered) {
      this.security.event('auth.refresh.recovered', {
        userId: result.session.userId,
        sessionId: result.session.familyId,
        ip,
      });
    }
    return this.issue(
      result.session.userId,
      result.session.organizationId,
      result.next,
      await this.memberships.organizationsOf(result.session.userId, scope),
    );
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
    organizations: OrganizationSummary[],
  ): Promise<IssuedSession> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const changeRequired = await this.passwordPolicy.changeRequired(user);
    const accessToken = await this.accessTokens.sign(
      {
        userId,
        organizationId,
        sessionId: refresh.familyId,
        passwordChangeRequired: changeRequired,
      },
      this.clock.now(),
    );
    return {
      refresh,
      body: {
        accessToken,
        expiresIn: this.accessTokens.ttlSeconds,
        sessionExpiresAt: refresh.familyExpiresAt.toISOString(),
        user: { id: user.id, email: user.email, locale: user.locale },
        organizations,
        activeOrganizationId: organizationId,
        ...(await this.accessIn(organizationId, userId)),
        passwordChangeRequired: changeRequired,
      },
    };
  }

  /** The caller's role, permissions and features in the active organization (UI hints, ADR 0007/0009). */
  private async accessIn(
    organizationId: string | null,
    userId: string,
  ): Promise<{
    activeRole: ActiveAccess['role'];
    activePermissions: string[];
    activeFeatures: string[];
  }> {
    const access =
      organizationId === null
        ? NO_ACTIVE_ACCESS
        : await this.activeAccess.lookup(organizationId, userId);
    return {
      activeRole: access.role,
      activePermissions: access.permissions,
      activeFeatures: access.features,
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
