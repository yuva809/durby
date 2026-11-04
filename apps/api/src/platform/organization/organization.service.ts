import { Inject, Injectable } from '@nestjs/common';
import type { Organization } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../audit';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';

/**
 * The organization of the token (never an id from the request). `organizations` holds only
 * non-sensitive platform fields and has no RLS, so the row is addressed by the tenant context's id;
 * the change and its audit row commit together in the tenant transaction.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
  ) {}

  /** The organization's name, for pages shown on its behalf (the public menu, ADR 0026). */
  async name(): Promise<string> {
    const { tenantId } = this.tenantContext.require();
    const row = await this.db.organization.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    return row.name;
  }

  rename(name: string): Promise<Organization> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({
        where: { id: tenantId },
        select: { id: true, name: true },
      });
      if (before.name === name) return before;
      const after = await tx.organization.update({
        where: { id: tenantId },
        data: { name },
        select: { id: true, name: true },
      });
      await this.audit.record(tx, {
        action: 'platform.organization.updated',
        actor: auditActor.user(userId),
        entityId: tenantId,
        before: snapshot('organization', before),
        after: snapshot('organization', after),
      });
      return after;
    });
  }
}
