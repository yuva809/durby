import { Injectable } from '@nestjs/common';
import { SYSTEM_ROLES, type SystemRole } from '@durby/shared';
import { TenantContext, type TenantTransactionClient } from '../tenancy';

/** The system roles every organization has (docs/platform/rbac.md → System roles). */
@Injectable()
export class SystemRoles {
  constructor(private readonly tenantContext: TenantContext) {}

  /**
   * Creates the missing system roles of the current tenant and returns all of their ids.
   * Idempotent, so it also completes an organization whose creation was interrupted. Runs in the
   * caller's tenant transaction (e.g. together with the organization and its audit row).
   */
  async ensure(tx: TenantTransactionClient): Promise<Record<SystemRole, string>> {
    const { tenantId } = this.tenantContext.require();
    await tx.role.createMany({
      data: SYSTEM_ROLES.map((systemKey) => ({ tenantId, systemKey })),
      skipDuplicates: true,
    });
    return this.ids(tx);
  }

  /** Ids of the current tenant's system roles. */
  async ids(tx: TenantTransactionClient): Promise<Record<SystemRole, string>> {
    const roles = await tx.role.findMany({
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
