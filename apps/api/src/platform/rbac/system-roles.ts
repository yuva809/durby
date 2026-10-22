import { Inject, Injectable } from '@nestjs/common';
import { SYSTEM_ROLES, type SystemRole } from '@durby/shared';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';

/** The system roles every organization has (docs/platform/rbac.md → System roles). */
@Injectable()
export class SystemRoles {
  constructor(
    private readonly tenantContext: TenantContext,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
  ) {}

  /**
   * Creates the missing system roles of the current tenant and returns all of their ids.
   * Idempotent, so it also completes an organization whose creation was interrupted.
   */
  async ensure(): Promise<Record<SystemRole, string>> {
    const { tenantId } = this.tenantContext.require();
    await this.db.role.createMany({
      data: SYSTEM_ROLES.map((systemKey) => ({ tenantId, systemKey })),
      skipDuplicates: true,
    });
    return this.ids();
  }

  /** Ids of the current tenant's system roles. */
  async ids(): Promise<Record<SystemRole, string>> {
    const roles = await this.db.role.findMany({
      where: { systemKey: { not: null } },
      select: { id: true, systemKey: true },
    });
    const ids: Partial<Record<SystemRole, string>> = {};
    for (const role of roles) if (role.systemKey) ids[role.systemKey] = role.id;
    for (const key of SYSTEM_ROLES) {
      if (!ids[key])
        throw new Error(`Organization ${this.tenantContext.require().tenantId} has no ${key} role`);
    }
    return ids as Record<SystemRole, string>;
  }
}
