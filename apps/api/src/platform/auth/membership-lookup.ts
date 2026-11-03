import { Inject, Injectable } from '@nestjs/common';
import type { OrganizationSummary } from '@durby/shared';
import { PrismaService } from '../database';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../tenancy';

/**
 * A user's memberships across tenants without bypassing RLS in the app (ADR 0006).
 * `userId` must come from a verified token or a just-verified login, never from a request.
 */
@Injectable()
export class MembershipLookup {
  constructor(
    private readonly raw: PrismaService,
    @Inject(TENANT_PRISMA) private readonly tenantDb: TenantPrismaClient,
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    private readonly tenantContext: TenantContext,
  ) {}

  /** All organizations of the user, by name. Via auth_user_organization_ids(), reading app.user_id. */
  async organizationsOf(userId: string): Promise<OrganizationSummary[]> {
    const [, rows] = await this.raw.$transaction([
      this.raw.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`,
      this.raw.$queryRaw<{ organization_id: string }[]>`
        SELECT organization_id FROM auth_user_organization_ids()`,
    ]);
    if (rows.length === 0) return [];
    // Deactivated memberships don't count (ADR 0023 §6). The definer function lists every membership;
    // each one is then checked inside its own tenant under RLS.
    const ids = rows.map((r) => r.organization_id);
    const active = (
      await Promise.all(ids.map(async (id) => ((await this.isMember(userId, id)) ? id : null)))
    ).filter((id): id is string => id !== null);
    if (active.length === 0) return [];
    return this.platformDb.organization.findMany({
      where: { id: { in: active } },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Whether the user is an active member of `organizationId` (a deactivated membership is not, ADR
   * 0023 §6). Runs with the tenant set to that org: RLS shows only its rows, so a claimed org id is
   * trusted only once this returns true.
   */
  async isMember(userId: string, organizationId: string): Promise<boolean> {
    const membership = await this.tenantContext.run({ tenantId: organizationId, userId }, () =>
      this.tenantDb.membership.findUnique({
        where: { tenantId_userId: { tenantId: organizationId, userId } },
        select: { id: true, deactivatedAt: true },
      }),
    );
    return membership !== null && membership.deactivatedAt === null;
  }
}
