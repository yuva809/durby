import { Inject, Injectable } from '@nestjs/common';
import {
  berlinDate,
  berlinEndOfDay,
  type CatalogFeature,
  type CustomerEntitlements,
  FEATURE_MODULES,
  FEATURES,
  type FeatureCatalogResponse,
  type FeatureKey,
  featureLimitNames,
  featuresOfModule,
  isFeatureKey,
  isPastBerlinDay,
  PLAN_KEYS,
  type PlanKey,
  planLabel,
  type ResetFeatureRequest,
  type SetFeatureRequest,
  type SetPlanRequest,
} from '@durby/shared';
import {
  type ChangeMeta,
  dependenciesOf,
  EntitlementsAdmin,
  EntitlementsDependencyError,
  EntitlementsInputError,
  type OrganizationEntitlements,
  type OverrideChange,
} from '../config/entitlements';
import { PrismaService } from '../database';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  type PlatformPrismaClient,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import { PlatformAuditService, platformSnapshot } from './platform-audit.service';
import { staffErrors } from './staff-errors';

/** The reason stored on overrides written while onboarding (admin portal 1d). */
export const ONBOARDING_REASON = 'onboarding';

/**
 * A customer's plan and modules in the admin portal (docs/platform/admin-portal.md → Modules,
 * step 1d). Every write goes through EntitlementsAdmin's cores in the customer's tenant
 * transaction, which also gets the platform audit row naming the staff member.
 */
@Injectable()
export class CustomerEntitlementsService {
  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly tenantDb: TenantPrismaClient,
    private readonly db: PrismaService,
    private readonly admin: EntitlementsAdmin,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  /** The registry as the portal shows it, plus what each plan includes. No module names in code. */
  async catalog(): Promise<FeatureCatalogResponse> {
    const plans = await this.platformDb.plan.findMany({
      where: { key: { in: [...PLAN_KEYS] } },
      select: { key: true, features: { select: { featureKey: true } } },
    });
    const byKey = new Map(plans.map((p) => [p.key, p.features.map((f) => f.featureKey)]));
    return {
      modules: FEATURE_MODULES.map((module) => ({
        ...catalogFeature(module),
        features: featuresOfModule(module).map(catalogFeature),
      })),
      plans: PLAN_KEYS.map((key) => ({
        key,
        label: planLabel(key),
        features: (byKey.get(key) ?? []).filter(isFeatureKey),
      })),
    };
  }

  async show(customerId: string): Promise<CustomerEntitlements> {
    const state = await this.guard(() => this.admin.show(customerId));
    return this.toResponse(state);
  }

  async setPlan(
    staffId: string,
    customerId: string,
    body: SetPlanRequest,
  ): Promise<CustomerEntitlements> {
    return this.write(customerId, async (tx) => {
      const change = await this.admin.setPlanIn(
        tx,
        customerId,
        body.plan,
        meta(staffId, body.reason),
      );
      if (change.changed) {
        const org = await tx.organization.findUniqueOrThrow({
          where: { id: customerId },
          select: { id: true, partnerId: true, name: true },
        });
        await this.platformAudit.record(tx, {
          action: 'staff.customer.plan_changed',
          actor: { staffId },
          entityId: customerId,
          organizationId: customerId,
          reason: body.reason,
          before: platformSnapshot('organization', { ...org, planId: change.before?.planId }),
          after: platformSnapshot('organization', { ...org, planId: change.after?.planId }),
        });
      }
    });
  }

  async setFeature(
    staffId: string,
    customerId: string,
    key: string,
    body: SetFeatureRequest,
  ): Promise<CustomerEntitlements> {
    const feature = requireKey(key);
    if (body.expiresOn !== undefined && isPastBerlinDay(body.expiresOn)) {
      throw staffErrors.expiryPast();
    }
    const expiresAt = body.expiresOn === undefined ? null : berlinEndOfDay(body.expiresOn);
    return this.write(customerId, async (tx) => {
      const change = await this.admin.setOverrideIn(
        tx,
        customerId,
        feature,
        body.enabled,
        body.limits,
        meta(staffId, body.reason),
        { expiresAt, requireDependencies: true },
      );
      await this.recordOverride(tx, staffId, customerId, change, body.reason);
    });
  }

  /** Back to the plan default. */
  async resetFeature(
    staffId: string,
    customerId: string,
    key: string,
    body: ResetFeatureRequest,
  ): Promise<CustomerEntitlements> {
    const feature = requireKey(key);
    return this.write(customerId, async (tx) => {
      const change = await this.admin.clearOverrideIn(
        tx,
        customerId,
        feature,
        meta(staffId, body.reason),
      );
      await this.recordOverride(tx, staffId, customerId, change, body.reason);
    });
  }

  /**
   * Onboarding (customers.service): the overrides that turn `plan` into the chosen module set. 409
   * before anything is written when a switched-on key needs one that ends up off.
   */
  async onboardingOverrides(
    plan: PlanKey,
    features: Partial<Record<FeatureKey, boolean>> | undefined,
  ): Promise<{ key: FeatureKey; enabled: boolean }[]> {
    if (!features || Object.keys(features).length === 0) return [];
    const row = await this.platformDb.plan.findUnique({
      where: { key: plan },
      select: { features: { select: { featureKey: true } } },
    });
    const inPlan = new Set(row?.features.map((f) => f.featureKey) ?? []);
    const on = (key: FeatureKey) => features[key] ?? inPlan.has(key);
    const missing = new Set<FeatureKey>();
    for (const key of Object.keys(FEATURES) as FeatureKey[]) {
      if (!on(key)) continue;
      for (const dep of dependenciesOf(key)) if (!on(dep)) missing.add(dep);
    }
    if (missing.size > 0) {
      throw staffErrors.featureDependencyMissing(
        (Object.keys(FEATURES) as FeatureKey[]).filter((k) => missing.has(k)),
      );
    }
    return (Object.entries(features) as [FeatureKey, boolean][])
      .filter(([key, enabled]) => enabled !== inPlan.has(key))
      .map(([key, enabled]) => ({ key, enabled }));
  }

  /** Inside onboarding's tenant transaction: one override (and both audit rows) per difference. */
  async applyOnboardingOverrides(
    tx: TenantTransactionClient,
    staffId: string,
    customerId: string,
    overrides: readonly { key: FeatureKey; enabled: boolean }[],
  ): Promise<void> {
    for (const { key, enabled } of overrides) {
      const change = await this.admin.setOverrideIn(
        tx,
        customerId,
        key,
        enabled,
        undefined,
        meta(staffId, ONBOARDING_REASON),
      );
      await this.recordOverride(tx, staffId, customerId, change, ONBOARDING_REASON);
    }
  }

  private async recordOverride(
    tx: TenantTransactionClient,
    staffId: string,
    customerId: string,
    change: OverrideChange,
    reason: string,
  ): Promise<void> {
    if (!change.changed || change.overrideId === null) return;
    await this.platformAudit.record(tx, {
      action:
        change.after === null
          ? 'staff.feature_override.deleted'
          : change.before === null
            ? 'staff.feature_override.created'
            : 'staff.feature_override.updated',
      actor: { staffId },
      entityId: change.overrideId,
      organizationId: customerId,
      reason,
      before: change.before ? platformSnapshot('feature_override', { ...change.before }) : null,
      after: change.after ? platformSnapshot('feature_override', { ...change.after }) : null,
    });
  }

  /** Runs `change` in the customer's tenant transaction, then answers with the new state. */
  private async write(
    customerId: string,
    change: (tx: TenantTransactionClient) => Promise<void>,
  ): Promise<CustomerEntitlements> {
    const state = await this.guard(() =>
      this.admin.asOrg(customerId, () =>
        this.tenantDb.$transaction(async (tx) => {
          await change(tx);
          return this.admin.showIn(tx, customerId);
        }),
      ),
    );
    return this.toResponse(state);
  }

  /** Maps the admin's input errors to the portal's stable codes. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof EntitlementsDependencyError) {
        throw staffErrors.featureDependencyMissing(error.missing);
      }
      if (error instanceof EntitlementsInputError) {
        switch (error.problem) {
          case 'unknown_organization':
            throw staffErrors.customerNotFound();
          case 'unknown_feature':
            throw staffErrors.featureUnknown();
          case 'invalid_limits':
            throw staffErrors.featureLimitsInvalid();
          default:
            throw error;
        }
      }
      throw error;
    }
  }

  private async toResponse(state: OrganizationEntitlements): Promise<CustomerEntitlements> {
    const staffIds = [
      ...new Set(state.overrides.flatMap((o) => (o.setByStaffId ? [o.setByStaffId] : []))),
    ];
    const staff =
      staffIds.length === 0
        ? []
        : await this.db.staffAccount.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, email: true },
          });
    const emails = new Map(staff.map((s) => [s.id, s.email]));
    return {
      customerId: state.organizationId,
      plan: state.planKey as PlanKey,
      features: state.features.map((f) => ({
        key: f.key,
        enabled: f.enabled,
        inPlan: f.inPlan,
        source: f.source,
        blockedBy: f.blockedBy,
        override: f.override && {
          enabled: f.override.enabled,
          limits: f.override.limits,
          reason: f.override.reason,
          expiresOn: f.override.expiresAt ? berlinDate(f.override.expiresAt) : null,
          expired: f.override.expired,
          setBy: f.override.setByStaffId
            ? { id: f.override.setByStaffId, email: emails.get(f.override.setByStaffId) ?? null }
            : null,
          updatedAt: f.override.updatedAt.toISOString(),
        },
      })),
    };
  }
}

function meta(staffId: string, reason: string): ChangeMeta {
  return { actor: 'staff.admin_portal', reason, setByStaffId: staffId };
}

function requireKey(key: string): FeatureKey {
  if (!isFeatureKey(key)) throw staffErrors.featureUnknown();
  return key;
}

function catalogFeature(key: FeatureKey): CatalogFeature {
  const def = FEATURES[key];
  return {
    key,
    label: def.label,
    description: def.description,
    dependsOn: [...(def.dependsOn as readonly FeatureKey[])],
    order: def.order,
    limits: featureLimitNames(key),
  };
}
