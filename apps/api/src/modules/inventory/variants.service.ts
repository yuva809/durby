import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateVariantAttributeRequest,
  type GenerateVariantsRequest,
  type GenerateVariantsResponse,
  type ListVariantAttributesQuery,
  MAX_VARIANTS_PER_ITEM,
  type StockItem,
  type UpdateVariantAttributeRequest,
  type VariantAttribute,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { inventoryErrors, isUniqueViolation } from './inventory-errors';
import { combinations, variantName } from './item-rules';
import { ITEM_SELECT, itemResponse, itemSnapshot } from './setup.service';
import { nextArchivedAt } from './units.service';

const ATTRIBUTE_SELECT = { id: true, name: true, values: true, archivedAt: true } as const;

interface AttributeRow {
  id: string;
  name: string;
  values: string[];
  archivedAt: Date | null;
}

/** Joins a combination into one map key (values never contain NUL). */
const comboKey = (values: readonly string[]) => values.join('\u0000');

/**
 * Variant attributes and item variants (docs/modules/inventory.md → Step 5, ADR 0038). A variant is an ordinary stock
 * item with a parent and the values it was made from, so receipts, adjustments, transfers and production work on it
 * unchanged; the parent holds no stock once it has variants (StockService refuses it).
 */
@Injectable()
export class VariantsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listAttributes(query: ListVariantAttributesQuery): Promise<VariantAttribute[]> {
    const rows = await this.db.variantAttribute.findMany({
      where: query.includeArchived ? {} : { archivedAt: null },
      select: ATTRIBUTE_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(attributeResponse);
  }

  async createAttribute(body: CreateVariantAttributeRequest): Promise<VariantAttribute> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.uniqueName(() =>
      this.db.$transaction(async (tx) => {
        const row = await tx.variantAttribute.create({
          data: { tenantId, name: body.name, values: body.values },
          select: ATTRIBUTE_SELECT,
        });
        const response = attributeResponse(row);
        await this.audit.record(tx, {
          action: 'inventory.variant_attribute.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          after: attributeSnapshot(response),
        });
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  /** Changing values never touches existing variants: they keep the values they were made with. */
  async updateAttribute(
    id: string,
    body: UpdateVariantAttributeRequest,
  ): Promise<VariantAttribute> {
    const { userId } = this.tenantContext.require();
    return this.uniqueName(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.variantAttribute.findUnique({
          where: { id },
          select: ATTRIBUTE_SELECT,
        });
        if (!current) throw inventoryErrors.attributeNotFound([id]);
        const before = attributeResponse(current);
        const archivedAt = nextArchivedAt(current.archivedAt, body.archived);
        const next: VariantAttribute = {
          ...before,
          name: body.name ?? before.name,
          values: body.values ?? before.values,
          archivedAt: archivedAt?.toISOString() ?? null,
        };
        if (JSON.stringify(attributeSnapshot(before)) === JSON.stringify(attributeSnapshot(next))) {
          return before;
        }
        const row = await tx.variantAttribute.update({
          where: { id },
          data: { name: next.name, values: next.values, archivedAt },
          select: ATTRIBUTE_SELECT,
        });
        const after = attributeResponse(row);
        await this.audit.record(tx, {
          action: 'inventory.variant_attribute.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before: attributeSnapshot(before),
          after: attributeSnapshot(after),
        });
        return after;
      }),
    );
  }

  /**
   * Creates the item's missing variants: one stock item per combination of the picked values, in the parent's unit,
   * named `Parent · v1 / v2`. The parent must be active, not a variant, and not yet hold stock or be used in a recipe
   * or bill of materials (its stock and uses would be stranded once documents refuse it).
   */
  async generate(itemId: string, body: GenerateVariantsRequest): Promise<GenerateVariantsResponse> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.uniqueItemName(() =>
      this.db.$transaction(async (tx) => {
        const parent = await tx.stockItem.findUnique({
          where: { id: itemId },
          select: { ...ITEM_SELECT, _count: { select: { variants: true } } },
        });
        if (!parent || parent.archivedAt) throw inventoryErrors.itemNotFound([itemId]);
        if (parent.parentItemId) throw inventoryErrors.variantNotAllowed();
        if (parent._count.variants === 0) {
          const [moved, recipe, bom, component] = await Promise.all([
            tx.stockMovement.findFirst({ where: { itemId }, select: { id: true } }),
            tx.recipeLine.findFirst({ where: { itemId }, select: { id: true } }),
            tx.bom.findFirst({ where: { itemId }, select: { id: true } }),
            tx.bomLine.findFirst({ where: { itemId }, select: { id: true } }),
          ]);
          if (moved || recipe || bom || component) throw inventoryErrors.variantNotAllowed();
        }

        const ids = body.attributes.map((a) => a.attributeId);
        const attributes = await tx.variantAttribute.findMany({
          where: { id: { in: ids }, archivedAt: null },
          select: ATTRIBUTE_SELECT,
        });
        const byId = new Map(attributes.map((a) => [a.id, a]));
        const unknown = ids.filter(
          (id, i) =>
            !byId.get(id) ||
            body.attributes[i]!.values.some((v) => !byId.get(id)!.values.includes(v)),
        );
        if (unknown.length > 0) throw inventoryErrors.attributeNotFound(unknown);
        // The picked values in the attribute's own order, each once.
        const lists = body.attributes.map((picked) =>
          byId.get(picked.attributeId)!.values.filter((v) => picked.values.includes(v)),
        );
        const combos = combinations(lists);
        if (combos.length > MAX_VARIANTS_PER_ITEM) {
          throw inventoryErrors.tooManyVariants(MAX_VARIANTS_PER_ITEM);
        }

        const existing = await tx.stockItem.findMany({
          where: { parentItemId: itemId },
          select: { variantValues: true },
        });
        const taken = new Set(existing.map((v) => comboKey(v.variantValues)));
        const fresh = combos.filter((values) => !taken.has(comboKey(values)));
        const created: StockItem[] = [];
        for (const [index, values] of fresh.entries()) {
          const row = await tx.stockItem.create({
            data: {
              tenantId,
              name: variantName(parent.name, values),
              sku: body.skuPrefix ? `${body.skuPrefix}-${existing.length + index + 1}` : null,
              unit: parent.unit,
              minQuantity: null,
              parentItemId: itemId,
              variantValues: values,
              // In its parent's category (ADR 0048), so the category's tile lists it.
              categoryId: parent.categoryId,
            },
            select: ITEM_SELECT,
          });
          const item = itemResponse(row);
          await this.audit.record(tx, {
            action: 'inventory.stock_item.created',
            actor: auditActor.user(userId),
            entityId: row.id,
            after: itemSnapshot(item),
          });
          created.push(item);
        }
        const response = { created, skipped: combos.length - fresh.length };
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  private async uniqueName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw inventoryErrors.attributeNameTaken();
      throw error;
    }
  }

  private async uniqueItemName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw inventoryErrors.itemNameTaken();
      throw error;
    }
  }
}

function attributeResponse(row: AttributeRow): VariantAttribute {
  return {
    id: row.id,
    name: row.name,
    values: row.values,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** Values joined in order: snapshots sort string arrays, and the order is part of the attribute. */
const attributeSnapshot = (attribute: VariantAttribute) =>
  snapshot('variant_attribute', { ...attribute, values: attribute.values.join(', ') });
