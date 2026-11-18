import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../database';
import type { UserTokenPurpose } from '../database/generated/client';
import { authErrors } from './auth-errors';
import { AuthMailer } from './auth-mailer';
import type { MailLinkTarget } from './link-base';
import { AuthRateLimits } from './auth-rate-limits';
import { Clock } from './clock';
import { emailKey, generateToken, hashToken, normalizeEmail } from './crypto';
import { LockoutService } from './lockout.service';
import { PasswordHasher } from './password-hasher';
import { PasswordPolicy } from './password-policy';
import { RevocationService } from './revocation.service';
import { SecurityLog } from './security-log';

const MIN = 60_000;
const TOKEN_TTL_MS: Record<UserTokenPurpose, number> = {
  password_reset: 30 * MIN,
  email_verification: 24 * 60 * MIN,
};
/** A new Owner's first password link (admin portal onboarding): days, not minutes. */
const OWNER_WELCOME_TTL_MS = 72 * 60 * MIN;

/** Where a mail's link opens (ADR 0041): the partner's domain, or the asking browser's site. */
interface LinkOptions {
  partnerId?: string;
  requestOrigin?: string;
}

/**
 * Forgot/reset password and email verification (docs/platform/auth.md). Responses never reveal
 * whether an email exists: requests answer 202 at once and the mail goes out afterwards.
 */
@Injectable()
export class PasswordService {
  constructor(
    private readonly db: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly mailer: AuthMailer,
    private readonly limits: AuthRateLimits,
    private readonly lockout: LockoutService,
    private readonly revocations: RevocationService,
    private readonly security: SecurityLog,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
    private readonly passwordPolicy: PasswordPolicy,
  ) {
    this.logger.setContext(PasswordService.name);
  }

  /**
   * Rate-limited; the reset mail (if the user exists) is sent in the background. `requestOrigin`: the asking
   * browser's Origin; the link opens on that site when it is an allowed web origin (ADR 0041).
   */
  async requestPasswordReset(email: string, ip: string, requestOrigin?: string): Promise<void> {
    await this.limits.enforce(
      [this.limits.rules.mailIp, ip],
      [this.limits.rules.mailEmail, emailKey(email)],
    );
    this.inBackground('password reset mail', async () => {
      const user = await this.db.user.findUnique({ where: { email: normalizeEmail(email) } });
      if (!user) return;
      // Set by an owner or admin (ADR 0052): no reset link; the answer is the same, so nothing is revealed.
      if (await this.passwordPolicy.managed(user)) {
        this.security.event('auth.password.reset_refused_managed', { userId: user.id, ip });
        return;
      }
      await this.sendPasswordSetMail(user.id, { requestOrigin });
      this.security.event('auth.password.reset_requested', { userId: user.id, ip });
    });
  }

  /**
   * Issues a reset token (cancelling older ones) and mails the link. Also used by create-admin to
   * let a new admin set their first password; with `partnerId` the link opens on that partner's domain.
   */
  async sendPasswordSetMail(userId: string, link: LinkOptions = {}): Promise<void> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const token = await this.issueToken(userId, 'password_reset');
    await this.mailer.send('reset', user.email, user.locale, token, await this.linkTarget(link));
  }

  /**
   * A new customer's Owner (admin portal onboarding, docs/platform/admin-portal.md): a set-password
   * link valid for 72 hours, through the usual reset page. Older open links stop working. The link opens on the
   * customer's partner domain when it has one (ADR 0041).
   */
  async sendOwnerWelcomeMail(
    userId: string,
    organization: string,
    partnerId?: string,
  ): Promise<void> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const token = await this.issueToken(userId, 'password_reset', OWNER_WELCOME_TTL_MS);
    await this.mailer.sendOwner(
      'ownerWelcome',
      user.email,
      user.locale,
      organization,
      token,
      await this.linkTarget({ partnerId }),
    );
  }

  /** An existing user made Owner of a new customer: a sign-in link, the password stays as it is. */
  async sendOwnerAddedMail(
    userId: string,
    organization: string,
    partnerId?: string,
  ): Promise<void> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    await this.mailer.sendOwner(
      'ownerAdded',
      user.email,
      user.locale,
      organization,
      undefined,
      await this.linkTarget({ partnerId }),
    );
  }

  /** The partner's domains (partner_domains: platform table, no tenant data) or the request origin. */
  private async linkTarget(link: LinkOptions): Promise<MailLinkTarget> {
    if (link.partnerId) {
      const domains = await this.db.partnerDomain.findMany({
        where: { partnerId: link.partnerId },
        select: { hostname: true },
        orderBy: { hostname: 'asc' },
      });
      return { partnerHostnames: domains.map((d) => d.hostname) };
    }
    return link.requestOrigin === undefined ? {} : { requestOrigin: link.requestOrigin };
  }

  /**
   * Sets the password, verifies the email (the user proved inbox access), cancels other reset
   * tokens, revokes every session and clears the lockout.
   */
  async resetPassword(token: string, password: string, ip: string): Promise<void> {
    await this.limits.enforce([this.limits.rules.tokenIp, ip]);
    const passwordHash = await this.hasher.hash(password);
    const now = this.clock.now();
    const user = await this.db.$transaction(async (tx) => {
      const userId = await this.consumeToken(tx, token, 'password_reset', now);
      await tx.userToken.updateMany({
        where: { userId, purpose: 'password_reset', usedAt: null },
        data: { usedAt: now },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'password_reset' },
      });
      const current = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      return tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: now,
          emailVerifiedAt: current.emailVerifiedAt ?? now,
        },
      });
    });
    await this.revocations.revokeUser(user.id, now).catch(() => {
      throw authErrors.unavailable();
    });
    await this.lockout.reset(emailKey(user.email)).catch(() => {
      throw authErrors.unavailable();
    });
    this.security.event('auth.password.reset', { userId: user.id, ip });
  }

  async verifyEmail(token: string, ip: string): Promise<void> {
    await this.limits.enforce([this.limits.rules.tokenIp, ip]);
    const now = this.clock.now();
    const userId = await this.db.$transaction(async (tx) => {
      const id = await this.consumeToken(tx, token, 'email_verification', now);
      await tx.user.updateMany({
        where: { id, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      return id;
    });
    this.security.event('auth.email.verified', { userId, ip });
  }

  /** Rate-limited; mails a new link only to an existing, unverified user. */
  async resendVerification(email: string, ip: string, requestOrigin?: string): Promise<void> {
    await this.limits.enforce(
      [this.limits.rules.mailIp, ip],
      [this.limits.rules.mailEmail, emailKey(email)],
    );
    this.inBackground('verification mail', async () => {
      const user = await this.db.user.findUnique({ where: { email: normalizeEmail(email) } });
      if (!user || user.emailVerifiedAt !== null) return;
      const token = await this.issueToken(user.id, 'email_verification');
      await this.mailer.send(
        'verify',
        user.email,
        user.locale,
        token,
        await this.linkTarget({ requestOrigin }),
      );
      this.security.event('auth.email.verification_requested', { userId: user.id, ip });
    });
  }

  /** New single-use token; older open tokens of the same purpose stop working. */
  private async issueToken(
    userId: string,
    purpose: UserTokenPurpose,
    ttlMs: number = TOKEN_TTL_MS[purpose],
  ): Promise<string> {
    const token = generateToken();
    const now = this.clock.now();
    await this.db.$transaction([
      this.db.userToken.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: now },
      }),
      this.db.userToken.create({
        data: {
          userId,
          purpose,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + ttlMs),
        },
      }),
    ]);
    return token;
  }

  /** Marks the token used if it is open and unexpired; one generic error for every other case. */
  private async consumeToken(
    tx: Pick<PrismaService, 'userToken'>,
    token: string,
    purpose: UserTokenPurpose,
    now: Date,
  ): Promise<string> {
    const tokenHash = hashToken(token);
    const { count } = await tx.userToken.updateMany({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) throw authErrors.tokenInvalid();
    const row = await tx.userToken.findUniqueOrThrow({ where: { tokenHash } });
    return row.userId;
  }

  /**
   * Runs after the response so its timing reveals nothing. Errors are logged by type only.
   * (Moves to a BullMQ job once queues exist.)
   */
  private inBackground(what: string, fn: () => Promise<void>): void {
    setImmediate(() => {
      fn().catch((error: unknown) => {
        this.logger.error(
          { err: { type: error instanceof Error ? error.name : 'unknown' } },
          `${what} failed`,
        );
      });
    });
  }
}
