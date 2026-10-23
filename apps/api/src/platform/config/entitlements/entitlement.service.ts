import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FeatureKey, FeatureLimitName } from '@durby/shared';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../tenancy';
import { entitlementsErrors } from './entitlements-errors';
import { type ResolvedEntitlements, resolveEntitlements } from './resolve';

const CLS_KEY = 'durby:entitlements';

interface Cached {
  tenantId: string;
  entitlements: Promise<ResolvedEntitlements>;
}

/**
 * The active organization's entitlements (docs/platform/entitlements.md → Resolution). Loaded from
 * the database once per request (cached in the request's CLS scope), so a plan switch or an
 * override applies to the next request. Needs only a tenant context, so jobs use it inside
 * TenantContext.run(); without an active CLS scope nothing is cached.
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly tenantContext: TenantContext,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
  ) {}

  /** The resolved entitlements of the current tenant. */
  current(): Promise<ResolvedEntitlements> {
    const { tenantId } = this.tenantContext.require();
    const active = this.cls.isActive();
    const cached = active ? this.cls.get<Cached | undefined>(CLS_KEY) : undefined;
    if (cached && cached.tenantId === tenantId) return cached.entitlements;
    const entitlements = this.load(tenantId);
    if (active) this.cls.set<Cached>(CLS_KEY, { tenantId, entitlements });
    return entitlements;
  }

  /** Drops the cached entitlements of this scope (after changing them). */
  forget(): void {
    if (this.cls.isActive()) this.cls.set(CLS_KEY, undefined);
  }

  /** Takes unregistered keys too (false), for the guard. */
  async isEnabled(key: string): Promise<boolean> {
    return (await this.current()).features.has(key as FeatureKey);
  }

  /** Throws 403 entitlements.feature_disabled unless `key` is enabled. */
  async assertEnabled(key: string): Promise<void> {
    if (!(await this.isEnabled(key))) throw entitlementsErrors.featureDisabled(key);
  }

  /** The limit; null = unlimited, 0 when the feature is disabled (fail closed). */
  async getLimit<K extends FeatureKey>(key: K, name: FeatureLimitName<K>): Promise<number | null> {
    const limits = (await this.current()).features.get(key);
    if (!limits) return 0;
    return limits[name] ?? null;
  }

  private async load(tenantId: string): Promise<ResolvedEntitlements> {
    const [organization, overrides] = await this.db.$transaction(async (tx) => [
      await tx.organization.findUnique({
        where: { id: tenantId },
        select: {
          plan: { select: { key: true, features: { select: { featureKey: true, limits: true } } } },
        },
      }),
      await tx.tenantFeatureOverride.findMany({
        where: { tenantId },
        select: { featureKey: true, enabled: true, limits: true },
      }),
    ]);
    return resolveEntitlements({ plan: organization?.plan ?? null, overrides }, (problem) =>
      this.logger.warn({ tenantId, problem }, 'Ignored stored entitlement'),
    );
  }
}
