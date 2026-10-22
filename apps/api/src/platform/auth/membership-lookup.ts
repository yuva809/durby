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
    return this.platformDb.organization.findMany({
      where: { id: { in: rows.map((r) => r.organization_id) } },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Whether the user is a member of `organizationId`. Runs with the tenant set to that org: RLS
   * shows only its rows, so a claimed org id is trusted only once this returns true.
   */
  async isMember(userId: string, organizationId: string): Promise<boolean> {
    const membership = await this.tenantContext.run({ tenantId: organizationId, userId }, () =>
      this.tenantDb.membership.findUnique({
        where: { tenantId_userId: { tenantId: organizationId, userId } },
        select: { id: true },
      }),
    );
    return membership !== null;
  }
}
