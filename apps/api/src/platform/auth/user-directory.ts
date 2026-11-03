import { Injectable } from '@nestjs/common';
import type { AuditActorDirectory } from '../audit';
import { PrismaService } from '../database';
import type { TenantTransactionClient } from '../tenancy';
import { normalizeEmail } from './crypto';
import { PasswordHasher } from './password-hasher';

export interface UserProfile {
  id: string;
  email: string;
  locale: string;
}

/**
 * The reads and writes of users that other platform modules need (ADR 0007). Users stay private
 * to platform/auth: only profiles (id, email, locale) leave it, never hashes or tokens.
 */
@Injectable()
export class UserDirectory implements AuditActorDirectory {
  constructor(
    private readonly db: PrismaService,
    private readonly hasher: PasswordHasher,
  ) {}

  async findByEmail(email: string): Promise<UserProfile | null> {
    return this.db.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true, email: true, locale: true },
    });
  }

  async findById(id: string): Promise<UserProfile | null> {
    return this.db.user.findUnique({
      where: { id },
      select: { id: true, email: true, locale: true },
    });
  }

  /** Profiles of the given users, e.g. members already read through the tenant client. */
  async profiles(ids: readonly string[]): Promise<Map<string, UserProfile>> {
    if (ids.length === 0) return new Map();
    const users = await this.db.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, email: true, locale: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  /** Which of the given users have set a password (never the hash itself). */
  async withPassword(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const users = await this.db.user.findMany({
      where: { id: { in: [...ids] }, passwordHash: { not: null } },
      select: { id: true },
    });
    return new Set(users.map((u) => u.id));
  }

  /** AuditActorDirectory: emails of audit actors, for display only (docs/platform/audit.md). */
  async emails(ids: readonly string[]): Promise<Map<string, string>> {
    const profiles = await this.profiles(ids);
    return new Map([...profiles].map(([id, profile]) => [id, profile.email]));
  }

  /**
   * Creates a user with a password and a verified email inside the caller's transaction (an
   * accepted invitation proves inbox access). Fails on the unique email if the user exists.
   */
  async createVerified(
    tx: TenantTransactionClient,
    input: { email: string; password: string; locale: string },
  ): Promise<UserProfile> {
    const passwordHash = await this.hasher.hash(input.password);
    return tx.user.create({
      data: {
        email: normalizeEmail(input.email),
        locale: input.locale,
        passwordHash,
        emailVerifiedAt: new Date(),
        passwordChangedAt: new Date(),
      },
      select: { id: true, email: true, locale: true },
    });
  }

  /**
   * An account an organization creates with a temporary password (ADR 0023 §3), inside the
   * caller's transaction: the email is not verified but vouched for by `organizationId`, and every
   * session is limited to changing the password until it is changed. Fails on the unique email if
   * the user exists.
   */
  async createWithTemporaryPassword(
    tx: TenantTransactionClient,
    input: { email: string; password: string; locale: string; organizationId: string },
  ): Promise<UserProfile> {
    const passwordHash = await this.hasher.hash(input.password);
    return tx.user.create({
      data: {
        email: normalizeEmail(input.email),
        locale: input.locale,
        passwordHash,
        mustChangePassword: true,
        vouchedByOrganizationId: input.organizationId,
      },
      select: { id: true, email: true, locale: true },
    });
  }

  /** Which of the given users still have to replace a temporary password. */
  async withTemporaryPassword(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const users = await this.db.user.findMany({
      where: { id: { in: [...ids] }, mustChangePassword: true },
      select: { id: true },
    });
    return new Set(users.map((u) => u.id));
  }

  /**
   * When each user last started or refreshed a session in `organizationId` (the newest refresh
   * token issued for it). Never the tokens themselves.
   */
  async lastActiveIn(organizationId: string, ids: readonly string[]): Promise<Map<string, Date>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.refreshToken.groupBy({
      by: ['userId'],
      where: { userId: { in: [...ids] }, organizationId },
      _max: { createdAt: true },
    });
    return new Map(
      rows.flatMap((r) => (r._max.createdAt ? [[r.userId, r._max.createdAt] as const] : [])),
    );
  }

  /**
   * Bootstrap commands only: finds the user or creates them. A new user gets no password unless
   * one is given (bootstrap admins set theirs through the password-set mail). An existing user is
   * returned unchanged.
   */
  async ensure(
    email: string,
    opts: { locale?: string; password?: string; verified?: boolean } = {},
  ): Promise<{ id: string; created: boolean }> {
    const normalized = normalizeEmail(email);
    const existing = await this.db.user.findUnique({ where: { email: normalized } });
    if (existing) return { id: existing.id, created: false };
    const user = await this.db.user.upsert({
      where: { email: normalized },
      create: {
        email: normalized,
        locale: opts.locale ?? 'en',
        passwordHash: opts.password === undefined ? null : await this.hasher.hash(opts.password),
        emailVerifiedAt: opts.verified ? new Date() : null,
      },
      update: {},
    });
    return { id: user.id, created: true };
  }
}
