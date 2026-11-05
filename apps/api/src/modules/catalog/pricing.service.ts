import { Inject, Injectable } from '@nestjs/common';
import {
  type CreatePriceRuleRequest,
  type EffectivePrice,
  type PrepStation,
  type PriceRule,
  priceRuleProblems,
  type PricesQuery,
  type PricesResponse,
  resolvePrice,
  type ResolvedPrice,
  type SettingKey,
  type SettingValue,
  type UpdatePriceRuleRequest,
  type Weekday,
  zonedParts,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { Clock } from '../../platform/auth';
import { type ResolvedSettings, SettingsService } from '../../platform/config/settings';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { catalogErrors } from './catalog-errors';
import { fixed2 } from './decimal-text';

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const inWeekOrder = (days: readonly string[]) =>
  [...days].sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b));

const RULE_SELECT = {
  id: true,
  name: true,
  locationId: true,
  productId: true,
  categoryId: true,
  kind: true,
  value: true,
  days: true,
  startsAt: true,
  endsAt: true,
  validFrom: true,
  validUntil: true,
  active: true,
} as const;

type RuleRow = {
  id: string;
  name: string;
  locationId: string | null;
  productId: string | null;
  categoryId: string | null;
  kind: PriceRule['kind'];
  value: { toFixed(digits: number): string };
  days: string[];
  startsAt: string | null;
  endsAt: string | null;
  validFrom: Date | null;
  validUntil: Date | null;
  active: boolean;
};

/** A product that can be ordered now, at the price the location charges (ADR 0030). */
export interface OrderableProduct {
  id: string;
  name: string;
  /** 2 decimals, after price rules. */
  price: string;
  /** 2 decimals. */
  taxRate: string;
  station: PrepStation;
}

/**
 * Price rules and the prices they give (docs/modules/catalog.md → Price rules, ADR 0030). The rules
 * are configuration (changed and deleted freely, audited); `resolvePrice` (shared) decides a price,
 * at the location's wall-clock time.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async listRules(): Promise<PriceRule[]> {
    const rows = await this.db.priceRule.findMany({
      select: RULE_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(ruleResponse);
  }

  async createRule(body: CreatePriceRuleRequest): Promise<PriceRule> {
    const { tenantId, userId } = this.tenantContext.require();
    const problems = priceRuleProblems(body);
    if (problems.length > 0) throw catalogErrors.priceRuleInvalid(problems);
    return this.db.$transaction(async (tx) => {
      await this.targetsExist(tx, body);
      const row = await tx.priceRule.create({
        data: { tenantId, ...ruleData(body) },
        select: RULE_SELECT,
      });
      const response = ruleResponse(row);
      await this.audit.record(tx, {
        action: 'catalog.price_rule.created',
        actor: auditActor.user(userId),
        entityId: row.id,
        after: ruleSnapshot(response),
      });
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  async updateRule(id: string, body: UpdatePriceRuleRequest): Promise<PriceRule> {
    const { userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      const current = await tx.priceRule.findUnique({ where: { id }, select: RULE_SELECT });
      if (!current) throw catalogErrors.priceRuleNotFound();
      const before = ruleResponse(current);
      const defined = Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined),
      ) as Partial<PriceRule>;
      const next: PriceRule = { ...before, ...defined };
      if (body.name !== undefined) next.name = body.name.trim();
      const problems = priceRuleProblems(next);
      if (problems.length > 0) throw catalogErrors.priceRuleInvalid(problems);
      if (JSON.stringify(normalize(next)) === JSON.stringify(normalize(before))) return before;
      await this.targetsExist(tx, next);
      const row = await tx.priceRule.update({
        where: { id },
        data: ruleData(next),
        select: RULE_SELECT,
      });
      const response = ruleResponse(row);
      await this.audit.record(tx, {
        action: 'catalog.price_rule.updated',
        actor: auditActor.user(userId),
        entityId: id,
        before: ruleSnapshot(before),
        after: ruleSnapshot(response),
      });
      return response;
    });
  }

  async deleteRule(id: string): Promise<void> {
    const { userId } = this.tenantContext.require();
    await this.db.$transaction(async (tx) => {
      const current = await tx.priceRule.findUnique({ where: { id }, select: RULE_SELECT });
      if (!current) throw catalogErrors.priceRuleNotFound();
      await tx.priceRule.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'catalog.price_rule.deleted',
        actor: auditActor.user(userId),
        entityId: id,
        before: ruleSnapshot(ruleResponse(current)),
      });
    });
  }

  /** `GET /catalog/prices`: every non-archived product's price at a location the caller may read. */
  async prices(query: PricesQuery): Promise<PricesResponse> {
    const scope = await this.access.locationIdsFor('catalog.products.read');
    if (scope !== 'all' && !scope.includes(query.locationId))
      throw catalogErrors.locationNotFound();
    const at = query.at ? new Date(query.at) : this.clock.now();
    return this.db.$transaction(async (tx) => {
      const priced = await this.pricesAt(tx, {
        locationId: query.locationId,
        at,
        timed: query.timed,
      });
      return {
        locationId: query.locationId,
        at: at.toISOString(),
        data: [...priced.entries()].map(([productId, p]): EffectivePrice => ({ productId, ...p })),
      };
    });
  }

  /**
   * The price of non-archived products (all, or `productIds`) at a location at `at`, in the caller's
   * transaction (ADR 0021). 404 for a location this organization doesn't have.
   */
  async pricesAt(
    tx: TenantTransactionClient,
    options: { locationId: string; at: Date; productIds?: string[]; timed?: boolean },
  ): Promise<Map<string, ResolvedPrice>> {
    const products = await tx.product.findMany({
      where: {
        archivedAt: null,
        ...(options.productIds && { id: { in: options.productIds } }),
      },
      select: { id: true, categoryId: true, price: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const resolve = await this.resolver(tx, options.locationId, options.at, options.timed);
    return new Map(
      products.map((p) => [
        p.id,
        resolve({ id: p.id, categoryId: p.categoryId, price: p.price.toFixed(2) }),
      ]),
    );
  }

  /**
   * For pos (ADR 0030 §4): the products that can be ordered (not archived, category not archived)
   * with the price the location charges at `at`; `missing` names the rest.
   */
  async orderableProducts(
    tx: TenantTransactionClient,
    ids: readonly string[],
    options: { locationId: string; at: Date },
  ): Promise<{ products: Map<string, OrderableProduct>; missing: string[] }> {
    const wanted = [...new Set(ids)];
    const rows = await tx.product.findMany({
      where: { id: { in: wanted }, archivedAt: null, category: { archivedAt: null } },
      select: {
        id: true,
        name: true,
        categoryId: true,
        price: true,
        taxRate: true,
        category: { select: { station: true } },
      },
    });
    const resolve = await this.resolver(tx, options.locationId, options.at);
    const products = new Map(
      rows.map((p) => [
        p.id,
        {
          id: p.id,
          name: p.name,
          price: resolve({ id: p.id, categoryId: p.categoryId, price: p.price.toFixed(2) }).price,
          taxRate: p.taxRate.toFixed(2),
          station: p.category.station,
        },
      ]),
    );
    return { products, missing: wanted.filter((id) => !products.has(id)) };
  }

  /** The location's active rules and wall clock at `at`, ready to price products. */
  private async resolver(tx: TenantTransactionClient, locationId: string, at: Date, timed = true) {
    const location = await tx.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) throw catalogErrors.locationNotFound();
    const [rules, resolved] = await Promise.all([
      tx.priceRule.findMany({
        where: { active: true, OR: [{ locationId: null }, { locationId }] },
        select: RULE_SELECT,
      }),
      this.settings.all({ locationId }, tx),
    ]);
    const { date, time } = zonedParts(at, setting(resolved, 'timezone'));
    const priced = rules.map(ruleResponse);
    return (product: { id: string; categoryId: string; price: string }) =>
      resolvePrice(product, priced, { locationId, date, time }, { timed });
  }

  /** The rule's product, category and location exist in this organization (RLS). */
  private async targetsExist(
    tx: TenantTransactionClient,
    rule: Pick<PriceRule, 'productId' | 'categoryId' | 'locationId'>,
  ): Promise<void> {
    if (rule.productId) {
      const found = await tx.product.findUnique({
        where: { id: rule.productId },
        select: { id: true },
      });
      if (!found) throw catalogErrors.productNotFound();
    }
    if (rule.categoryId) {
      const found = await tx.productCategory.findUnique({
        where: { id: rule.categoryId },
        select: { id: true },
      });
      if (!found) throw catalogErrors.categoryNotFound();
    }
    if (rule.locationId) {
      const found = await tx.location.findUnique({
        where: { id: rule.locationId },
        select: { id: true },
      });
      if (!found) throw catalogErrors.locationNotFound();
    }
  }
}

function setting<K extends SettingKey>(resolved: ResolvedSettings, key: K): SettingValue<K> {
  return resolved.get(key)?.value as SettingValue<K>;
}

const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const date = (value: string | null) => (value === null ? null : new Date(`${value}T00:00:00Z`));

function ruleResponse(row: RuleRow): PriceRule {
  return {
    ...row,
    value: row.value.toFixed(2),
    days: row.days as Weekday[],
    validFrom: day(row.validFrom),
    validUntil: day(row.validUntil),
  };
}

/** Days in weekday order and the value with two decimals, so equal rules compare equal. */
function normalize(rule: PriceRule) {
  return { ...rule, value: fixed2(rule.value), days: inWeekOrder(rule.days) };
}

function ruleData(rule: Omit<PriceRule, 'id'> | CreatePriceRuleRequest) {
  return {
    name: rule.name.trim(),
    locationId: rule.locationId,
    productId: rule.productId,
    categoryId: rule.categoryId,
    kind: rule.kind,
    value: rule.value,
    days: inWeekOrder(rule.days),
    startsAt: rule.startsAt,
    endsAt: rule.endsAt,
    validFrom: date(rule.validFrom),
    validUntil: date(rule.validUntil),
    active: rule.active,
  };
}

/** Flat snapshot (ADR 0008): weekdays as one comma-separated value. */
function ruleSnapshot(rule: PriceRule) {
  return snapshot('price_rule', { ...rule, days: rule.days.join(',') });
}
