import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../tenancy';
import { normalizeEmail } from './crypto';
import { PasswordHasher } from './password-hasher';

export interface Ensured {
  id: string;
  created: boolean;
}

/**
 * Idempotent creation of partners, organizations, users and memberships for the bootstrap
 * commands (create-admin, seed-dev). Each call finds the existing row or creates it; nothing is
 * ever overwritten. Not used by request handling.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly raw: PrismaService,
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly tenantDb: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly hasher: PasswordHasher,
  ) {}

  async ensurePartner(slug: string, name: string): Promise<Ensured> {
    const existing = await this.platformDb.partner.findUnique({ where: { slug } });
    if (existing) return { id: existing.id, created: false };
    const partner = await this.platformDb.partner.upsert({
      where: { slug },
      create: { slug, name },
      update: {},
    });
    return { id: partner.id, created: true };
  }

  /** Organizations are matched by exact name within the partner. */
  async ensureOrganization(partnerId: string, name: string): Promise<Ensured> {
    const existing = await this.platformDb.organization.findFirst({
      where: { partnerId, name },
      orderBy: { id: 'asc' },
    });
    if (existing) return { id: existing.id, created: false };
    const org = await this.platformDb.organization.create({ data: { partnerId, name } });
    return { id: org.id, created: true };
  }

  /**
   * A new user gets no password unless one is given (bootstrap admins set theirs through the
   * password-set mail). An existing user is returned unchanged.
   */
  async ensureUser(
    email: string,
    opts: { locale?: string; password?: string; verified?: boolean } = {},
  ): Promise<Ensured> {
    const normalized = normalizeEmail(email);
    const existing = await this.raw.user.findUnique({ where: { email: normalized } });
    if (existing) return { id: existing.id, created: false };
    const user = await this.raw.user.upsert({
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

  async ensureMembership(organizationId: string, userId: string): Promise<Ensured> {
    return this.tenantContext.run({ tenantId: organizationId, userId }, async () => {
      const where = { tenantId_userId: { tenantId: organizationId, userId } };
      const existing = await this.tenantDb.membership.findUnique({ where });
      if (existing) return { id: existing.id, created: false };
      const membership = await this.tenantDb.membership.upsert({
        where,
        create: { tenantId: organizationId, userId },
        update: {},
      });
      return { id: membership.id, created: true };
    });
  }
}
