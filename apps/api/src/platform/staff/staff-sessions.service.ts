import { Inject, Injectable } from '@nestjs/common';
import { STAFF_ROLE_PERMISSIONS, type StaffMeResponse } from '@durby/shared';
import {
  AuthRateLimits,
  authErrors,
  Clock,
  emailKey,
  generateToken,
  hashToken,
  LockoutService,
  LockoutUnavailableError,
  normalizeEmail,
  PasswordHasher,
  SecurityLog,
} from '../auth';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../database';
import type { Prisma } from '../database/generated/client';
import { PlatformAuditService, platformSnapshot } from './platform-audit.service';
import type { StaffContextValue } from './staff-context';
import { staffErrors } from './staff-errors';

/** Sensitive routes need a password confirmation this recent (ADR 0017 §3). */
export const FRESH_MS = 15 * 60_000;

/** A session token for the cookie and when it ends. */
export interface IssuedStaffSession {
  token: string;
  expiresAt: Date;
}

/**
 * Staff sign-in (docs/platform/admin-portal.md → API): email and password, or an accepted
 * invitation, open a session of at most STAFF_SESSION_TTL_SECONDS. No second factor (ADR 0017 §5,
 * amended 2026-10-29).
 */
@Injectable()
export class StaffSessionsService {
  constructor(
    private readonly db: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly lockout: LockoutService,
    private readonly limits: AuthRateLimits,
    private readonly security: SecurityLog,
    private readonly clock: Clock,
    private readonly audit: PlatformAuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(input: { email: string; password: string }, ip: string): Promise<IssuedStaffSession> {
    const key = `staff:${emailKey(input.email)}`;
    await this.limits.enforce([this.limits.rules.loginIp, ip], [this.limits.rules.loginEmail, key]);
    const lock = await this.lockoutCall(() => this.lockout.check(key));
    if (lock.locked) {
      this.security.event('staff.login.locked', { emailKey: key, ip });
      throw authErrors.tooManyAttempts(lock.retryAfterSeconds);
    }
    const staff = await this.db.staffAccount.findUnique({
      where: { email: normalizeEmail(input.email) },
    });
    // Same work for unknown, invited (no password) and deactivated accounts: no enumeration.
    const valid = await this.hasher.verify(staff?.passwordHash ?? null, input.password);
    if (!staff || !valid || staff.status !== 'active') {
      await this.lockoutCall(() => this.lockout.recordFailure(key));
      this.security.event('staff.login.failed', { staffId: staff?.id, emailKey: key, ip });
      throw staffErrors.invalidCredentials();
    }
    await this.lockoutCall(() => this.lockout.reset(key));
    return this.db.$transaction((tx) => this.start(tx, staff.id));
  }

  /** An invitation link: sets the password, activates the account and signs it in. */
  async accept(token: string, password: string, ip: string): Promise<IssuedStaffSession> {
    await this.limits.enforce([this.limits.rules.tokenIp, ip]);
    const now = this.clock.now();
    const passwordHash = await this.hasher.hash(password);
    return this.db.$transaction(async (tx) => {
      const row = await tx.staffToken.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, usedAt: true, expiresAt: true, staff: true },
      });
      if (!row || row.usedAt || row.expiresAt <= now || row.staff.status !== 'invited') {
        throw staffErrors.invitationInvalid();
      }
      // Single use, also under concurrency: only one request flips used_at.
      const { count } = await tx.staffToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (count !== 1) throw staffErrors.invitationInvalid();
      const after = await tx.staffAccount.update({
        where: { id: row.staff.id },
        data: { passwordHash, status: 'active' },
      });
      await this.audit.record(tx, {
        action: 'staff.account.activated',
        actor: { staffId: after.id },
        entityId: after.id,
        before: platformSnapshot('staff_account', row.staff),
        after: platformSnapshot('staff_account', after),
      });
      return this.start(tx, after.id);
    });
  }

  /** The password again: sensitive routes are open for the next 15 minutes. */
  async reauth(ctx: Readonly<StaffContextValue>, password: string): Promise<void> {
    const staff = await this.db.staffAccount.findUniqueOrThrow({ where: { id: ctx.staffId } });
    const key = `staff:${emailKey(staff.email)}`;
    const lock = await this.lockoutCall(() => this.lockout.check(key));
    if (lock.locked) throw authErrors.tooManyAttempts(lock.retryAfterSeconds);
    if (!(await this.hasher.verify(staff.passwordHash, password))) {
      await this.lockoutCall(() => this.lockout.recordFailure(key));
      throw staffErrors.invalidCredentials();
    }
    await this.db.staffSession.update({
      where: { id: ctx.sessionId },
      data: { authenticatedAt: this.clock.now() },
    });
  }

  /** Ends the cookie's session. Idempotent. */
  async logout(token: string | undefined, ip: string): Promise<void> {
    if (!token) return;
    const session = await this.db.staffSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, staffId: true },
    });
    if (!session) return;
    await this.db.staffSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    this.security.event('staff.logout', { staffId: session.staffId, sessionId: session.id, ip });
  }

  /** The staff member of a live session, or null (the guard answers 401). */
  async authenticate(token: string): Promise<StaffContextValue | null> {
    const session = await this.db.staffSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        expiresAt: true,
        revokedAt: true,
        authenticatedAt: true,
        staff: { select: { id: true, role: true, status: true } },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= this.clock.now() ||
      session.authenticatedAt === null ||
      session.staff.status !== 'active'
    ) {
      return null;
    }
    return {
      staffId: session.staff.id,
      sessionId: session.id,
      role: session.staff.role,
      authenticatedAt: session.authenticatedAt,
    };
  }

  async me(ctx: Readonly<StaffContextValue>): Promise<StaffMeResponse> {
    const staff = await this.db.staffAccount.findUniqueOrThrow({
      where: { id: ctx.staffId },
      select: { id: true, email: true, role: true },
    });
    const freshUntil = new Date(ctx.authenticatedAt.getTime() + FRESH_MS);
    return {
      ...staff,
      permissions: [...STAFF_ROLE_PERMISSIONS[staff.role]],
      freshUntil: freshUntil > this.clock.now() ? freshUntil.toISOString() : null,
    };
  }

  /** A new session from now on, recorded as a sign-in. */
  private async start(tx: Prisma.TransactionClient, staffId: string): Promise<IssuedStaffSession> {
    const now = this.clock.now();
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + this.config.STAFF_SESSION_TTL_SECONDS * 1000);
    await tx.staffSession.create({
      data: { staffId, tokenHash: hashToken(token), expiresAt, authenticatedAt: now },
      select: { id: true },
    });
    await tx.staffAccount.update({ where: { id: staffId }, data: { lastLoginAt: now } });
    await this.audit.record(tx, {
      action: 'staff.session.logged_in',
      actor: { staffId },
      entityId: staffId,
    });
    return { token, expiresAt };
  }

  private async lockoutCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof LockoutUnavailableError) throw authErrors.unavailable();
      throw error;
    }
  }
}
