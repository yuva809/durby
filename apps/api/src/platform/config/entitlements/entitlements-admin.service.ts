import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditSystemActor,
  FEATURES,
  type FeatureKey,
  isFeatureKey,
  PLAN_KEYS,
} from '@durby/shared';
import { auditActor, AuditService, canonicalJson, snapshot } from '../../audit';
import { Prisma } from '../../database/generated/client';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../tenancy';
import { EntitlementService } from './entitlement.service';
import type { ResolvedEntitlements } from './resolve';

/** Tenant-context actor for operator commands that no user performs. */
const OPERATOR_ACTOR = '00000000-0000-0000-0000-000000000000';

/** Invalid operator input: nothing was written. The message is for the operator (CLI only). */
export class EntitlementsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitlementsInputError';
  }
}

export interface OrganizationEntitlements {
  organizationId: string;
  planKey: string | null;
  overrides: { featureKey: string; enabled: boolean; limits: Record<string, number> | null }[];
  resolved: ResolvedEntitlements;
  /** Enabled by the plan or an override but off because a dependency is disabled. */
  blockedByDependency: FeatureKey[];
}

export interface Changed {
  changed: boolean;
}

/**
 * Changes an organization's plan and feature overrides (docs/platform/entitlements.md → Changing
 * plans and overrides). For the `entitlements` CLI only until platform staff is modelled: there
 * are no HTTP write endpoints. Every change and its audit row are written in one tenant
 * transaction; no-ops write nothing. Plan contents are never changed here (migrations only).
 */
@Injectable()
export class EntitlementsAdmin {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async show(organizationId: string): Promise<OrganizationEntitlements> {
    return this.asOrg(organizationId, async () => {
      const [organization, overrides] = await this.db.$transaction(async (tx) => [
        await this.organization(tx, organizationId),
        await tx.tenantFeatureOverride.findMany({
          where: { tenantId: organizationId },
          select: { featureKey: true, enabled: true, limits: true },
          orderBy: { featureKey: 'asc' },
        }),
      ]);
      this.entitlements.forget();
      const resolved = await this.entitlements.current();
      const own = new Map<string, boolean>();
      for (const f of organization.plan?.features ?? []) own.set(f.featureKey, true);
      for (const o of overrides) own.set(o.featureKey, o.enabled);
      return {
        organizationId,
        planKey: organization.plan?.key ?? null,
        overrides: overrides.map((o) => ({
          featureKey: o.featureKey,
          enabled: o.enabled,
          limits: o.limits as Record<string, number> | null,
        })),
        resolved,
        blockedByDependency: (Object.keys(FEATURES) as FeatureKey[]).filter(
          (key) => own.get(key) === true && !resolved.features.has(key),
        ),
      };
    });
  }

  async setPlan(
    organizationId: string,
    planKey: string,
    actor: AuditSystemActor,
  ): Promise<Changed> {
    return this.asOrg(organizationId, () =>
      this.db.$transaction(async (tx) => {
        const planId = await planIdOf(tx, planKey);
        const current = await this.organization(tx, organizationId, true);
        if (current.planId === planId) return { changed: false };
        await tx.organization.update({ where: { id: organizationId }, data: { planId } });
        await this.audit.record(tx, {
          action: 'platform.organization.plan_changed',
          actor: auditActor.system(actor),
          entityId: organizationId,
          before: snapshot('organization', { id: organizationId, planId: current.planId }),
          after: snapshot('organization', { id: organizationId, planId }),
        });
        return { changed: true };
      }),
    );
  }

  /** `limits` only with `enabled`; validated against the feature's strict schema. `{}` = none. */
  async setOverride(
    organizationId: string,
    featureKey: string,
    enabled: boolean,
    limits: unknown,
    actor: AuditSystemActor,
  ): Promise<Changed> {
    const key = requireFeatureKey(featureKey);
    const stored = parseLimits(key, enabled, limits);
    return this.asOrg(organizationId, () =>
      this.db.$transaction(async (tx) => {
        await this.organization(tx, organizationId, true);
        const where = { tenantId_featureKey: { tenantId: organizationId, featureKey: key } };
        const existing = await tx.tenantFeatureOverride.findUnique({ where });
        if (
          existing &&
          existing.enabled === enabled &&
          canonicalJson(existing.limits) === canonicalJson(stored)
        ) {
          return { changed: false };
        }
        const data = { enabled, limits: stored ?? Prisma.DbNull };
        const row = existing
          ? await tx.tenantFeatureOverride.update({ where, data })
          : await tx.tenantFeatureOverride.create({
              data: { tenantId: organizationId, featureKey: key, ...data },
            });
        await this.audit.record(tx, {
          action: existing
            ? 'platform.feature_override.updated'
            : 'platform.feature_override.created',
          actor: auditActor.system(actor),
          entityId: row.id,
          before: existing ? overrideSnapshot(existing) : null,
          after: overrideSnapshot(row),
        });
        return { changed: true };
      }),
    );
  }

  async clearOverride(
    organizationId: string,
    featureKey: string,
    actor: AuditSystemActor,
  ): Promise<Changed> {
    const key = requireFeatureKey(featureKey);
    return this.asOrg(organizationId, () =>
      this.db.$transaction(async (tx) => {
        await this.organization(tx, organizationId, true);
        const where = { tenantId_featureKey: { tenantId: organizationId, featureKey: key } };
        const existing = await tx.tenantFeatureOverride.findUnique({ where });
        if (!existing) return { changed: false };
        await tx.tenantFeatureOverride.delete({ where });
        await this.audit.record(tx, {
          action: 'platform.feature_override.deleted',
          actor: auditActor.system(actor),
          entityId: existing.id,
          before: overrideSnapshot(existing),
        });
        return { changed: true };
      }),
    );
  }

  private asOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    if (!UUID.test(organizationId))
      throw new EntitlementsInputError(`Not a uuid: ${organizationId}`);
    return this.tenantContext.run({ tenantId: organizationId, userId: OPERATOR_ACTOR }, fn);
  }

  /** The organization (locked with `lock`, so concurrent changes serialize), or a clean error. */
  private async organization(tx: TenantTransactionClient, id: string, lock = false) {
    if (lock) await tx.$queryRaw`SELECT 1 FROM organizations WHERE id = ${id}::uuid FOR UPDATE`;
    const organization = await tx.organization.findUnique({
      where: { id },
      select: {
        planId: true,
        plan: { select: { key: true, features: { select: { featureKey: true } } } },
      },
    });
    if (!organization) throw new EntitlementsInputError(`Unknown organization: ${id}`);
    return organization;
  }
}

/** The id of a plan created by the migrations (PLAN_KEYS), or EntitlementsInputError. */
export async function planIdOf(tx: TenantTransactionClient, key: string): Promise<string> {
  const plan = (PLAN_KEYS as readonly string[]).includes(key)
    ? await tx.plan.findUnique({ where: { key }, select: { id: true } })
    : null;
  if (!plan) {
    throw new EntitlementsInputError(`Unknown plan: ${key} (one of ${PLAN_KEYS.join(', ')})`);
  }
  return plan.id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireFeatureKey(key: string): FeatureKey {
  if (!isFeatureKey(key)) {
    throw new EntitlementsInputError(
      `Unknown feature: ${key} (one of ${Object.keys(FEATURES).join(', ')})`,
    );
  }
  return key;
}

function parseLimits(
  key: FeatureKey,
  enabled: boolean,
  limits: unknown,
): Prisma.InputJsonObject | null {
  if (limits === undefined || limits === null) return null;
  if (!enabled) throw new EntitlementsInputError('Limits are only allowed with --enable');
  const parsed = FEATURES[key].limits.safeParse(limits);
  if (!parsed.success) {
    throw new EntitlementsInputError(
      `Invalid limits for ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data as Record<string, number | undefined>;
  return Object.keys(data).length === 0 ? null : data;
}

function overrideSnapshot(row: {
  id: string;
  featureKey: string;
  enabled: boolean;
  limits: unknown;
}) {
  return snapshot('feature_override', {
    id: row.id,
    featureKey: row.featureKey,
    enabled: row.enabled,
    limits: canonicalJson(row.limits),
  });
}
