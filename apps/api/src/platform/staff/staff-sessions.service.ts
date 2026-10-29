import { Inject, Injectable } from '@nestjs/common';
import {
  STAFF_ROLE_PERMISSIONS,
  type StaffEnrollResponse,
  type StaffLoginResponse,
  type StaffMeResponse,
} from '@durby/shared';
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
import { PlatformAuditService, platformSnapshot } from './platform-audit.service';
import { SecretBox } from './secret-box';
import type { StaffContextValue } from './staff-context';
import { staffErrors } from './staff-errors';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';

/** Between password and code: long enough to open the app, short enough to be useless if stolen. */
const PENDING_TTL_MS = 10 * 60_000;
/** Sensitive routes need a password + code confirmation this recent (ADR 0017 §3). */
export const FRESH_MS = 15 * 60_000;
/** Shown in authenticator apps next to the account. */
const TOTP_ISSUER = 'Staff portal';

/** A session token for the cookie and when it ends. */
export interface IssuedStaffSession {
  token: string;
  expiresAt: Date;
}

/**
 * Staff sign-in (docs/platform/admin-portal.md → API). A session is `pending` after the password
 * (or an accepted invitation) and becomes `active` only with a TOTP code: no 2FA, no access. The
 * token is rotated on activation.
 */
@Injectable()
export class StaffSessionsService {
  private readonly box: SecretBox;

  constructor(
    private readonly db: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly lockout: LockoutService,
    private readonly limits: AuthRateLimits,
    private readonly security: SecurityLog,
    private readonly clock: Clock,
    private readonly audit: PlatformAuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox(config.STAFF_TOTP_KEY);
  }

  async login(
    input: { email: string; password: string },
    ip: string,
  ): Promise<{ body: StaffLoginResponse; session: IssuedStaffSession }> {
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
    if (!staff || !valid || staff.status === 'deactivated') {
      await this.lockoutCall(() => this.lockout.recordFailure(key));
      this.security.event('staff.login.failed', { staffId: staff?.id, emailKey: key, ip });
      throw staffErrors.invalidCredentials();
    }
    await this.lockoutCall(() => this.lockout.reset(key));
    const session = await this.startPending(staff.id);
    return { body: { next: staff.totpEnrolledAt ? 'totp' : 'enroll' }, session };
  }

  /** An invitation link: sets the password, then the invitee enrolls 2FA in the same session. */
  async accept(
    token: string,
    password: string,
    ip: string,
  ): Promise<{ body: StaffLoginResponse; session: IssuedStaffSession }> {
    await this.limits.enforce([this.limits.rules.tokenIp, ip]);
    const now = this.clock.now();
    const passwordHash = await this.hasher.hash(password);
    const staffId = await this.db.$transaction(async (tx) => {
      const row = await tx.staffToken.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
          id: true,
          usedAt: true,
          expiresAt: true,
          staff: { select: { id: true, status: true } },
        },
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
      await tx.staffAccount.update({ where: { id: row.staff.id }, data: { passwordHash } });
      return row.staff.id;
    });
    return { body: { next: 'enroll' }, session: await this.startPending(staffId) };
  }

  /** A new secret for the authenticator app, kept until confirmed; only while not enrolled. */
  async enroll(token: string | undefined): Promise<StaffEnrollResponse> {
    const { staff } = await this.pending(token);
    if (staff.totpEnrolledAt) throw staffErrors.enrollNotAllowed();
    const secret = generateTotpSecret();
    await this.db.staffAccount.update({
      where: { id: staff.id },
      data: { totpSecret: this.box.seal(secret) },
    });
    return { secret, otpauthUri: otpauthUri(secret, staff.email, TOTP_ISSUER) };
  }

  async confirmEnrollment(token: string | undefined, code: string): Promise<IssuedStaffSession> {
    const { session, staff } = await this.pending(token);
    if (staff.totpEnrolledAt) throw staffErrors.enrollNotAllowed();
    if (!staff.totpSecret) throw staffErrors.invalidCode();
    const step = await this.checkCode(staff, code);
    return this.activate(session.id, staff.id, step, staff.status === 'invited');
  }

  async verifyCode(token: string | undefined, code: string): Promise<IssuedStaffSession> {
    const { session, staff } = await this.pending(token);
    if (!staff.totpEnrolledAt) throw staffErrors.invalidCode();
    const step = await this.checkCode(staff, code);
    return this.activate(session.id, staff.id, step, false);
  }

  /** Password + code again: sensitive routes are open for the next 15 minutes. */
  async reauth(ctx: Readonly<StaffContextValue>, password: string, code: string): Promise<void> {
    const staff = await this.db.staffAccount.findUniqueOrThrow({ where: { id: ctx.staffId } });
    const key = `staff:${emailKey(staff.email)}`;
    const lock = await this.lockoutCall(() => this.lockout.check(key));
    if (lock.locked) throw authErrors.tooManyAttempts(lock.retryAfterSeconds);
    if (!(await this.hasher.verify(staff.passwordHash, password))) {
      await this.lockoutCall(() => this.lockout.recordFailure(key));
      throw staffErrors.invalidCredentials();
    }
    const step = await this.checkCode(staff, code);
    await this.db.$transaction([
      this.db.staffAccount.update({
        where: { id: staff.id },
        data: { totpLastStep: BigInt(step) },
      }),
      this.db.staffSession.update({
        where: { id: ctx.sessionId },
        data: { authenticatedAt: this.clock.now() },
      }),
    ]);
  }

  /** Ends the cookie's session, whatever its state. Idempotent. */
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

  /** The staff member of an active session, or null (the guard answers 401). */
  async authenticate(token: string): Promise<StaffContextValue | null> {
    const now = this.clock.now();
    const session = await this.db.staffSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        state: true,
        expiresAt: true,
        revokedAt: true,
        authenticatedAt: true,
        staff: { select: { id: true, role: true, status: true, totpEnrolledAt: true } },
      },
    });
    if (
      !session ||
      session.state !== 'active' ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.authenticatedAt === null ||
      session.staff.status !== 'active' ||
      session.staff.totpEnrolledAt === null
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

  private async startPending(staffId: string): Promise<IssuedStaffSession> {
    const token = generateToken();
    const expiresAt = new Date(this.clock.now().getTime() + PENDING_TTL_MS);
    await this.db.staffSession.create({
      data: { staffId, tokenHash: hashToken(token), state: 'pending', expiresAt },
      select: { id: true },
    });
    return { token, expiresAt };
  }

  /** The pending session of the cookie and its (not deactivated) account; 401 otherwise. */
  private async pending(token: string | undefined) {
    if (!token) throw staffErrors.unauthenticated();
    const session = await this.db.staffSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { staff: true },
    });
    if (
      !session ||
      session.state !== 'pending' ||
      session.revokedAt ||
      session.expiresAt <= this.clock.now() ||
      session.staff.status === 'deactivated'
    ) {
      throw staffErrors.unauthenticated();
    }
    return { session, staff: session.staff };
  }

  /** The accepted time step; a wrong code counts towards a lock on the account. */
  private async checkCode(
    staff: { id: string; totpSecret: string | null; totpLastStep: bigint | null },
    code: string,
  ): Promise<number> {
    const key = `staff-code:${staff.id}`;
    const lock = await this.lockoutCall(() => this.lockout.check(key));
    if (lock.locked) throw authErrors.tooManyAttempts(lock.retryAfterSeconds);
    const step =
      staff.totpSecret === null
        ? null
        : verifyTotp(
            this.box.open(staff.totpSecret),
            code,
            this.clock.now(),
            staff.totpLastStep === null ? null : Number(staff.totpLastStep),
          );
    if (step === null) {
      await this.lockoutCall(() => this.lockout.recordFailure(key));
      this.security.event('staff.code.failed', { staffId: staff.id });
      throw staffErrors.invalidCode();
    }
    await this.lockoutCall(() => this.lockout.reset(key));
    return step;
  }

  /** Pending → active with a new token; the session lasts STAFF_SESSION_TTL_SECONDS from now. */
  private async activate(
    sessionId: string,
    staffId: string,
    step: number,
    firstEnrollment: boolean,
  ): Promise<IssuedStaffSession> {
    const now = this.clock.now();
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + this.config.STAFF_SESSION_TTL_SECONDS * 1000);
    await this.db.$transaction(async (tx) => {
      const before = await tx.staffAccount.findUniqueOrThrow({ where: { id: staffId } });
      const after = await tx.staffAccount.update({
        where: { id: staffId },
        data: {
          totpLastStep: BigInt(step),
          lastLoginAt: now,
          ...(before.totpEnrolledAt === null && { totpEnrolledAt: now }),
          ...(firstEnrollment && { status: 'active' }),
        },
      });
      // Only a still-pending session becomes active (a concurrent second code is refused).
      const { count } = await tx.staffSession.updateMany({
        where: { id: sessionId, state: 'pending', revokedAt: null },
        data: { state: 'active', tokenHash: hashToken(token), expiresAt, authenticatedAt: now },
      });
      if (count !== 1) throw staffErrors.unauthenticated();
      if (firstEnrollment) {
        await this.audit.record(tx, {
          action: 'staff.account.activated',
          actor: { staffId },
          entityId: staffId,
          before: platformSnapshot('staff_account', before),
          after: platformSnapshot('staff_account', after),
        });
      }
      await this.audit.record(tx, {
        action: 'staff.session.logged_in',
        actor: { staffId },
        entityId: staffId,
      });
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
