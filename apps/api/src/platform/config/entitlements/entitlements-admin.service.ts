import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditSystemActor,
  FEATURE_KEYS,
  FEATURES,
  type FeatureKey,
  isFeatureKey,
  PLAN_KEYS,
} from '@durby/shared';
import { auditActor, AuditService, canonicalJson, snapshot } from '../../audit';
import { OutboxService } from '../../outbox';
import { Prisma } from '../../database/generated/client';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../tenancy';
import { EntitlementService } from './entitlement.service';
import { isExpired, type ResolvedEntitlements } from './resolve';

/** Tenant-context actor for operator commands that no user performs. */
const OPERATOR_ACTOR = '00000000-0000-0000-0000-000000000000';

export type EntitlementsInputProblem =
  'unknown_organization' | 'unknown_plan' | 'unknown_feature' | 'invalid_limits' | 'invalid_input';

/**
 * Invalid input: nothing was written. The message is for the operator (CLI); the staff portal maps
 * `problem` to its own error codes.
 */
export class EntitlementsInputError extends Error {
  constructor(
    message: string,
    readonly problem: EntitlementsInputProblem = 'invalid_input',
  ) {
    super(message);
    this.name = 'EntitlementsInputError';
  }
}

/** Enabling a feature whose dependencies are off (staff writes only; nothing was written). */
export class EntitlementsDependencyError extends Error {
  constructor(readonly missing: FeatureKey[]) {
    super(`Enable first: ${missing.join(', ')}`);
    this.name = 'EntitlementsDependencyError';
  }
}

/** Who changes entitlements, and why (admin portal 1d). */
export interface ChangeMeta {
  /** Tenant audit actor: `cli.entitlements`, or `staff.admin_portal` (ADR 0017 §8). */
  actor: AuditSystemActor;
  /** Stored on the override and in its snapshot; required by the staff api, optional for the CLI. */
  reason?: string | null;
  /** The staff member, stored on the override (`set_by_staff_id`). */
  setByStaffId?: string | null;
}

export interface OverrideOptions {
  /** End of the override (an instant; staff pick a Berlin day). Null: no end. */
  expiresAt?: Date | null;
  /** Refuse (EntitlementsDependencyError) when enabling a feature whose dependencies are off. */
  requireDependencies?: boolean;
}

export interface StoredOverride {
  id: string;
  featureKey: string;
  enabled: boolean;
  limits: Record<string, number> | null;
  reason: string | null;
  expiresAt: Date | null;
  setByStaffId: string | null;
  updatedAt: Date;
  /** Expired overrides count as absent (the plan applies) until changed or reset. */
  expired: boolean;
}

export type FeatureSource = 'plan' | 'override' | 'dependency' | 'expired-override';

export interface FeatureState {
  key: FeatureKey;
  /** Effective: own state on and every dependency on. */
  enabled: boolean;
  /** The plan includes it. */
  inPlan: boolean;
  /**
   * `override`: an active override decides; `expired-override`: an override expired and the plan
   * decides; `plan`: the plan decides; `dependency`: switched on but off because of `blockedBy`.
   */
  source: FeatureSource;
  override: StoredOverride | null;
  /** Dependencies (transitive, registry order) that are off while this key is switched on. */
  blockedBy: FeatureKey[];
}

export interface OrganizationEntitlements {
  organizationId: string;
  planKey: string | null;
  overrides: StoredOverride[];
  resolved: ResolvedEntitlements;
  /** Every registered key in registry order. */
  features: FeatureState[];
  /** Enabled by the plan or an override but off because a dependency is disabled. */
  blockedByDependency: FeatureKey[];
}

export interface Changed {
  changed: boolean;
}

/** A change with its audit snapshots, for a caller that records more in the same transaction. */
export interface PlanChange extends Changed {
  before: { planId: string } | null;
  after: { planId: string } | null;
}

export interface OverrideSnapshot {
  id: string;
  featureKey: string;
  enabled: boolean;
  limits: string | null;
  expiresAt: string | null;
  reason: string | null;
  setByStaffId: string | null;
}

export interface OverrideChange extends Changed {
  /** The override row (created, updated or deleted); null on a no-op without a row. */
  overrideId: string | null;
  before: OverrideSnapshot | null;
  after: OverrideSnapshot | null;
}

const OVERRIDE_SELECT = {
  id: true,
  featureKey: true,
  enabled: true,
  limits: true,
  reason: true,
  expiresAt: true,
  setByStaffId: true,
  updatedAt: true,
} as const;

/**
 * Changes an organization's plan and feature overrides (docs/platform/entitlements.md → Changing
 * plans and overrides), for the `entitlements` CLI, onboarding and the staff portal. Each public
 * write runs its change and audit row in one tenant transaction; the `…In(tx, …)` cores do the
 * same inside a caller's transaction (in the organization's tenant context), so the staff portal
 * adds its platform audit row there. No-ops write nothing. Plan contents are never changed here.
 */
@Injectable()
export class EntitlementsAdmin {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async show(organizationId: string, now: Date = new Date()): Promise<OrganizationEntitlements> {
    return this.asOrg(organizationId, () =>
      this.db.$transaction((tx) => this.showIn(tx, organizationId, now)),
    );
  }

  /** As show(), inside the caller's transaction (the organization's tenant context). */
  async showIn(
    tx: TenantTransactionClient,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<OrganizationEntitlements> {
    this.requireTenant(organizationId);
    const organization = await this.organization(tx, organizationId);
    const rows = await tx.tenantFeatureOverride.findMany({
      where: { tenantId: organizationId },
      select: OVERRIDE_SELECT,
      orderBy: { featureKey: 'asc' },
    });
    const overrides: StoredOverride[] = rows.map((o) => ({
      ...o,
      limits: o.limits as Record<string, number> | null,
      expired: isExpired(o, now),
    }));
    this.entitlements.forget();
    const resolved = await this.entitlements.resolveIn(tx, now);
    const inPlan = new Set((organization.plan?.features ?? []).map((f) => f.featureKey));
    const byKey = new Map(overrides.map((o) => [o.featureKey, o]));
    const own = (key: FeatureKey): boolean => {
      const o = byKey.get(key);
      return o && !o.expired ? o.enabled : inPlan.has(key);
    };
    const features = FEATURE_KEYS.map((key): FeatureState => {
      const override = byKey.get(key) ?? null;
      const enabled = resolved.features.has(key);
      const blockedBy =
        own(key) && !enabled ? dependenciesOf(key).filter((d) => !resolved.features.has(d)) : [];
      const source: FeatureSource =
        blockedBy.length > 0
          ? 'dependency'
          : override === null
            ? 'plan'
            : override.expired
              ? 'expired-override'
              : 'override';
      return { key, enabled, inPlan: inPlan.has(key), source, override, blockedBy };
    });
    return {
      organizationId,
      planKey: organization.plan?.key ?? null,
      overrides,
      resolved,
      features,
      blockedByDependency: features.filter((f) => f.blockedBy.length > 0).map((f) => f.key),
    };
  }

  async setPlan(
    organizationId: string,
    planKey: string,
    meta: ChangeMeta | AuditSystemActor,
  ): Promise<Changed> {
    return this.asOrg(organizationId, () =>
      this.db.$transaction((tx) => this.setPlanIn(tx, organizationId, planKey, metaOf(meta))),
    );
  }

  /** Overrides stay in place; only the plan changes. */
  async setPlanIn(
    tx: TenantTransactionClient,
    organizationId: string,
    planKey: string,
    meta: ChangeMeta,
  ): Promise<PlanChange> {
    this.requireTenant(organizationId);
    const planId = await planIdOf(tx, planKey);
    const current = await this.organization(tx, organizationId, true);
    if (current.planId === planId) return { changed: false, before: null, after: null };
    await tx.organization.update({ where: { id: organizationId }, data: { planId } });
    await this.audit.record(tx, {
      action: 'platform.organization.plan_changed',
      actor: auditActor.system(meta.actor),
      entityId: organizationId,
      before: snapshot('organization', { id: organizationId, planId: current.planId }),
      after: snapshot('organization', { id: organizationId, planId }),
    });
    await this.changed(tx);
    return { changed: true, before: { planId: current.planId }, after: { planId } };
  }

  /** `limits` only with `enabled`; validated against the feature's strict schema. `{}` = none. */
  async setOverride(
    organizationId: string,
    featureKey: string,
    enabled: boolean,
    limits: unknown,
    meta: ChangeMeta | AuditSystemActor,
    options: OverrideOptions = {},
  ): Promise<Changed> {
    return this.asOrg(organizationId, () =>
      this.db.$transaction((tx) =>
        this.setOverrideIn(tx, organizationId, featureKey, enabled, limits, metaOf(meta), options),
      ),
    );
  }

  async setOverrideIn(
    tx: TenantTransactionClient,
    organizationId: string,
    featureKey: string,
    enabled: boolean,
    limits: unknown,
    meta: ChangeMeta,
    options: OverrideOptions = {},
  ): Promise<OverrideChange> {
    this.requireTenant(organizationId);
    const key = requireFeatureKey(featureKey);
    const stored = parseLimits(key, enabled, limits);
    const expiresAt = options.expiresAt ?? null;
    await this.organization(tx, organizationId, true);
    if (enabled && options.requireDependencies) {
      // Dependencies as they are now, before this change (it can't enable its own dependencies).
      const resolved = await this.entitlements.resolveIn(tx);
      const missing = dependenciesOf(key).filter((dep) => !resolved.features.has(dep));
      if (missing.length > 0) throw new EntitlementsDependencyError(missing);
    }
    const where = { tenantId_featureKey: { tenantId: organizationId, featureKey: key } };
    const existing = await tx.tenantFeatureOverride.findUnique({ where });
    if (
      existing &&
      existing.enabled === enabled &&
      canonicalJson(existing.limits) === canonicalJson(stored) &&
      (existing.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null)
    ) {
      // A different reason alone is no change (admin portal 1d).
      return { changed: false, overrideId: existing.id, before: null, after: null };
    }
    const data = {
      enabled,
      limits: stored ?? Prisma.DbNull,
      expiresAt,
      reason: meta.reason ?? null,
      setByStaffId: meta.setByStaffId ?? null,
    };
    const row = existing
      ? await tx.tenantFeatureOverride.update({ where, data })
      : await tx.tenantFeatureOverride.create({
          data: { tenantId: organizationId, featureKey: key, ...data },
        });
    const before = existing ? overrideSnapshot(existing) : null;
    const after = overrideSnapshot(row);
    await this.audit.record(tx, {
      action: existing ? 'platform.feature_override.updated' : 'platform.feature_override.created',
      actor: auditActor.system(meta.actor),
      entityId: row.id,
      before: before ? snapshot('feature_override', before) : null,
      after: snapshot('feature_override', after),
    });
    await this.changed(tx);
    return { changed: true, overrideId: row.id, before, after };
  }

  async clearOverride(
    organizationId: string,
    featureKey: string,
    meta: ChangeMeta | AuditSystemActor,
  ): Promise<Changed> {
    return this.asOrg(organizationId, () =>
      this.db.$transaction((tx) =>
        this.clearOverrideIn(tx, organizationId, featureKey, metaOf(meta)),
      ),
    );
  }

  /** Back to the plan. The deletion's audit row carries the override as it was. */
  async clearOverrideIn(
    tx: TenantTransactionClient,
    organizationId: string,
    featureKey: string,
    meta: ChangeMeta,
  ): Promise<OverrideChange> {
    this.requireTenant(organizationId);
    const key = requireFeatureKey(featureKey);
    await this.organization(tx, organizationId, true);
    const where = { tenantId_featureKey: { tenantId: organizationId, featureKey: key } };
    const existing = await tx.tenantFeatureOverride.findUnique({ where });
    if (!existing) return { changed: false, overrideId: null, before: null, after: null };
    await tx.tenantFeatureOverride.delete({ where });
    const before = overrideSnapshot(existing);
    await this.audit.record(tx, {
      action: 'platform.feature_override.deleted',
      actor: auditActor.system(meta.actor),
      entityId: existing.id,
      before: snapshot('feature_override', before),
    });
    await this.changed(tx);
    return { changed: true, overrideId: existing.id, before, after: null };
  }

  /** Runs `fn` in the organization's tenant context (validates the id first). */
  asOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    if (!UUID.test(organizationId)) {
      throw new EntitlementsInputError(`Not a uuid: ${organizationId}`, 'unknown_organization');
    }
    return this.tenantContext.run({ tenantId: organizationId, userId: OPERATOR_ACTOR }, fn);
  }

  /** Every plan or override change emits `config.entitlements.changed` in its transaction. */
  private async changed(tx: TenantTransactionClient): Promise<void> {
    this.entitlements.forget();
    await this.outbox.add(tx, { type: 'config.entitlements.changed', payload: {} });
  }

  /** The `…In` cores write audit rows in the current tenant: it must be the organization. */
  private requireTenant(organizationId: string): void {
    if (this.tenantContext.require().tenantId !== organizationId) {
      throw new Error('EntitlementsAdmin: run inside the organization’s tenant context');
    }
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
    if (!organization) {
      throw new EntitlementsInputError(`Unknown organization: ${id}`, 'unknown_organization');
    }
    return organization;
  }
}

/** A bare actor (tests, scripts) is a change without reason or staff member. */
function metaOf(meta: ChangeMeta | AuditSystemActor): ChangeMeta {
  return typeof meta === 'string' ? { actor: meta } : meta;
}

/** The id of a plan created by the migrations (PLAN_KEYS), or EntitlementsInputError. */
export async function planIdOf(tx: TenantTransactionClient, key: string): Promise<string> {
  const plan = (PLAN_KEYS as readonly string[]).includes(key)
    ? await tx.plan.findUnique({ where: { key }, select: { id: true } })
    : null;
  if (!plan) {
    throw new EntitlementsInputError(
      `Unknown plan: ${key} (one of ${PLAN_KEYS.join(', ')})`,
      'unknown_plan',
    );
  }
  return plan.id;
}

/** Every key `key` depends on, transitively, in registry order. */
export function dependenciesOf(key: FeatureKey): FeatureKey[] {
  const found = new Set<FeatureKey>();
  const visit = (k: FeatureKey) => {
    for (const dep of FEATURES[k].dependsOn as readonly FeatureKey[]) {
      if (!found.has(dep)) {
        found.add(dep);
        visit(dep);
      }
    }
  };
  visit(key);
  return FEATURE_KEYS.filter((k) => found.has(k));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireFeatureKey(key: string): FeatureKey {
  if (!isFeatureKey(key)) {
    throw new EntitlementsInputError(
      `Unknown feature: ${key} (one of ${Object.keys(FEATURES).join(', ')})`,
      'unknown_feature',
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
  if (!enabled) {
    throw new EntitlementsInputError('Limits are only allowed with --enable', 'invalid_limits');
  }
  const parsed = FEATURES[key].limits.safeParse(limits);
  if (!parsed.success) {
    throw new EntitlementsInputError(
      `Invalid limits for ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      'invalid_limits',
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
  expiresAt: Date | null;
  reason: string | null;
  setByStaffId: string | null;
}): OverrideSnapshot {
  return {
    id: row.id,
    featureKey: row.featureKey,
    enabled: row.enabled,
    limits: canonicalJson(row.limits),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    reason: row.reason,
    setByStaffId: row.setByStaffId,
  };
}
