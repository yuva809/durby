import { Inject, Injectable } from '@nestjs/common';
import type { AuditSystemActor, PlanKey, SystemRole } from '@durby/shared';
import { v7 as uuidv7 } from 'uuid';
import { auditActor, AuditService, snapshot } from '../audit';
import { UserDirectory } from '../auth';
import { planIdOf } from '../config/entitlements';
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
 * row or creates it; nothing is ever overwritten. Not used by request handling. Creations and
 * changes in an organization are audited with the command as system actor; no-ops write nothing.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly tenantDb: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly users: UserDirectory,
    private readonly systemRoles: SystemRoles,
    private readonly audit: AuditService,
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
   * Organizations are matched by exact name within the partner. A new organization (on `plan`), its
   * system roles and its audit row are created in one transaction. An existing organization keeps
   * its plan (change it with the entitlements CLI). The system roles are ensured on every
   * call, so an organization whose creation was interrupted (before this step) is completed.
   */
  async ensureOrganization(
    partnerId: string,
    name: string,
    actor: AuditSystemActor,
    plan: PlanKey = 'full',
  ): Promise<Ensured> {
    const existing = await this.platformDb.organization.findFirst({
      where: { partnerId, name },
      orderBy: { id: 'asc' },
    });
    const id = existing?.id ?? uuidv7();
    await this.tenantContext.run({ tenantId: id, userId: PROVISIONING_ACTOR }, () =>
      this.tenantDb.$transaction(async (tx) => {
        if (!existing) {
          const planId = await planIdOf(tx, plan);
          const org = await tx.organization.create({ data: { id, partnerId, name, planId } });
          await this.audit.record(tx, {
            action: 'platform.organization.created',
            actor: auditActor.system(actor),
            entityId: org.id,
            after: snapshot('organization', org),
          });
        }
        await this.systemRoles.ensure(tx);
      }),
    );
    return { id, created: existing === null };
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
    actor: AuditSystemActor,
  ): Promise<Ensured> {
    return this.tenantContext.run({ tenantId: organizationId, userId }, () =>
      this.tenantDb.$transaction(async (tx) => {
        const roleId = (await this.systemRoles.ids(tx))[role];
        const where = { tenantId_userId: { tenantId: organizationId, userId } };
        // skipDuplicates: a concurrent run that created it first makes this a no-op, not an error.
        const { count } = await tx.membership.createMany({
          data: [{ tenantId: organizationId, userId, roleId }],
          skipDuplicates: true,
        });
        const membership = await tx.membership.findUniqueOrThrow({ where });
        const view = (roleId: string | null) =>
          snapshot('membership', {
            id: membership.id,
            userId,
            roleId,
            allLocations: membership.allLocations,
            locationIds: [],
          });
        if (count === 1) {
          await this.audit.record(tx, {
            action: 'platform.membership.created',
            actor: auditActor.system(actor),
            entityId: membership.id,
            after: view(roleId),
          });
          return { id: membership.id, created: true };
        }
        if (membership.roleId === null) {
          await tx.membership.update({ where, data: { roleId } });
          await this.audit.record(tx, {
            action: 'platform.membership.updated',
            actor: auditActor.system(actor),
            entityId: membership.id,
            before: view(null),
            after: view(roleId),
          });
        }
        return { id: membership.id, created: false };
      }),
    );
  }
}
