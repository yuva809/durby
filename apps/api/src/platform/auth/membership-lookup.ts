import { Inject, Injectable } from '@nestjs/common';
import { normalizeHost, type OrganizationSummary } from '@durby/shared';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../database';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../tenancy';

/** The organizations a site shows (ADR 0042): a partner's own domain, or the main site. */
export type OrganizationScope =
  { kind: 'partner'; partnerId: string } | { kind: 'main'; excludedPartnerIds: string[] };

const scopeWhere = (scope: OrganizationScope) =>
  scope.kind === 'partner'
    ? { partnerId: scope.partnerId }
    : scope.excludedPartnerIds.length > 0
      ? { partnerId: { notIn: scope.excludedPartnerIds } }
      : {};

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
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.servedHostnames = config.WEB_ORIGINS.flatMap((origin) => {
      try {
        return [new URL(origin).hostname];
      } catch {
        return [];
      }
    });
  }

  /** Hostnames of WEB_ORIGINS: a partner domain among them is a site of its own. */
  private readonly servedHostnames: string[];

  /**
   * Which organizations a site shows (ADR 0042). On a partner's own domain: that partner's. On any other host (the
   * main site): every organization except those of partners served on a domain of their own (a partner domain in
   * WEB_ORIGINS), so a user who belongs to both sees each organization only on its own site.
   */
  async scopeForHost(host: string | null | undefined): Promise<OrganizationScope> {
    const hostname = normalizeHost(host);
    if (hostname) {
      const own = await this.platformDb.partnerDomain.findUnique({
        where: { hostname },
        select: { partnerId: true },
      });
      if (own) return { kind: 'partner', partnerId: own.partnerId };
    }
    const served = await this.platformDb.partnerDomain.findMany({
      where: { hostname: { in: this.servedHostnames } },
      select: { partnerId: true },
    });
    return { kind: 'main', excludedPartnerIds: [...new Set(served.map((d) => d.partnerId))] };
  }

  /** Whether `organizationId` belongs to the site's organizations. */
  async inScope(organizationId: string, scope: OrganizationScope): Promise<boolean> {
    const count = await this.platformDb.organization.count({
      where: { id: organizationId, ...scopeWhere(scope) },
    });
    return count > 0;
  }

  /**
   * The user's organizations, by name; with `scope`, only those of the site (ADR 0042). Via
   * auth_user_organization_ids(), reading app.user_id.
   */
  async organizationsOf(userId: string, scope?: OrganizationScope): Promise<OrganizationSummary[]> {
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
      where: { id: { in: active }, ...(scope ? scopeWhere(scope) : {}) },
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
