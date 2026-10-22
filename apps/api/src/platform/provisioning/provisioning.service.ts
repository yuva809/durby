import { Inject, Injectable } from '@nestjs/common';
import type { SystemRole } from '@durby/shared';
import { UserDirectory } from '../auth';
import { SystemRoles } from '../rbac';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../tenancy';

export interface Ensured {
  id: string;
  created: boolean;
}

/** Tenant-context actor for provisioning work that no user performs (bootstrap commands). */
const PROVISIONING_ACTOR = '00000000-0000-0000-0000-000000000000';

/**
 * Idempotent creation of partners, organizations (with their system roles), users and
 * memberships for the bootstrap commands (create-admin, seed-dev). Each call finds the existing
 * row or creates it; nothing is ever overwritten. Not used by request handling.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly tenantDb: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly users: UserDirectory,
    private readonly systemRoles: SystemRoles,
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

  /**
   * Organizations are matched by exact name within the partner. The system roles are ensured on
   * every call, so an organization whose creation was interrupted is completed.
   */
  async ensureOrganization(partnerId: string, name: string): Promise<Ensured> {
    const existing = await this.platformDb.organization.findFirst({
      where: { partnerId, name },
      orderBy: { id: 'asc' },
    });
    const org =
      existing ?? (await this.platformDb.organization.create({ data: { partnerId, name } }));
    await this.tenantContext.run({ tenantId: org.id, userId: PROVISIONING_ACTOR }, () =>
      this.systemRoles.ensure(),
    );
    return { id: org.id, created: existing === null };
  }

  ensureUser(
    email: string,
    opts: { locale?: string; password?: string; verified?: boolean } = {},
  ): Promise<Ensured> {
    return this.users.ensure(email, opts);
  }

  /**
   * The membership with `role`. An existing membership keeps its role; only a missing one (from
   * before step 1.3 or the previous release) is filled in.
   */
  async ensureMembership(
    organizationId: string,
    userId: string,
    role: SystemRole,
  ): Promise<Ensured> {
    return this.tenantContext.run({ tenantId: organizationId, userId }, async () => {
      const roleId = (await this.systemRoles.ids())[role];
      const where = { tenantId_userId: { tenantId: organizationId, userId } };
      const existing = await this.tenantDb.membership.findUnique({ where });
      if (existing) {
        if (existing.roleId === null) {
          await this.tenantDb.membership.update({ where, data: { roleId } });
        }
        return { id: existing.id, created: false };
      }
      const membership = await this.tenantDb.membership.upsert({
        where,
        create: { tenantId: organizationId, userId, roleId },
        update: {},
      });
      return { id: membership.id, created: true };
    });
  }
}
