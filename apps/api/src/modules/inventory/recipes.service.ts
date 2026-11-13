import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { DishCost, PutRecipeRequest, Recipe } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantDb,
  type TenantPrismaClient,
} from '../../platform/tenancy';
import { CatalogService } from '../catalog';
import { inventoryErrors } from './inventory-errors';
import { costText, valueOf } from './valuation';

type Db = TenantDb;

/**
 * Recipes and dish costs (docs/modules/inventory.md → Step 2, ADR 0028). A recipe is the stock
 * items one portion of a catalog product uses; products are checked through catalog's public
 * service (no foreign key, ADR 0024). Recipes are configuration: replaced as a whole and audited.
 */
@Injectable()
export class RecipesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  async get(productId: string): Promise<Recipe> {
    await this.product(productId);
    return recipeOf(asTenantDb(this.db), productId);
  }

  /** Replaces the recipe; the same lines again change nothing. */
  async put(productId: string, body: PutRecipeRequest): Promise<Recipe> {
    const { tenantId, userId } = this.tenantContext.require();
    const product = await this.product(productId);
    if (product.archivedAt) throw inventoryErrors.productNotFound();
    return this.db.$transaction(async (tx) => {
      const itemIds = body.lines.map((l) => l.itemId);
      const items = await tx.stockItem.findMany({
        where: { id: { in: itemIds }, archivedAt: null },
        select: { id: true, _count: { select: { variants: { where: { archivedAt: null } } } } },
      });
      const found = new Set(items.map((i) => i.id));
      const missing = itemIds.filter((id) => !found.has(id));
      if (missing.length > 0) throw inventoryErrors.itemNotFound(missing);
      // A parent holds no stock once it has variants (ADR 0038): sales would book nothing real.
      const parents = items.filter((i) => i._count.variants > 0).map((i) => i.id);
      if (parents.length > 0) throw inventoryErrors.itemHasVariants(parents);

      const before = await tx.recipeLine.findMany({
        where: { productId },
        select: { itemId: true, quantity: true },
      });
      const key = (lines: { itemId: string; quantity: string }[]) =>
        lines
          .map((l) => `${l.itemId}:${new Decimal(l.quantity).toFixed(3)}`)
          .sort()
          .join(',');
      const beforeLines = before.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity.toFixed(3),
      }));
      if (key(beforeLines) !== key(body.lines)) {
        await tx.recipeLine.deleteMany({ where: { productId } });
        await tx.recipeLine.createMany({
          data: body.lines.map((l) => ({
            tenantId,
            productId,
            itemId: l.itemId,
            quantity: new Decimal(l.quantity).toFixed(3),
          })),
        });
        await this.audit.record(tx, {
          action: 'inventory.recipe.updated',
          actor: auditActor.user(userId),
          entityId: productId,
          before: recipeSnapshot(productId, beforeLines),
          after: recipeSnapshot(productId, body.lines),
        });
      }
      return recipeOf(tx, productId);
    });
  }

  /** Cost per portion of every non-archived product with a recipe. */
  async costs(): Promise<DishCost[]> {
    const lines = await this.db.recipeLine.findMany({
      select: { productId: true, itemId: true, quantity: true },
      orderBy: [{ productId: 'asc' }, { id: 'asc' }],
    });
    if (lines.length === 0) return [];
    const products = await this.catalog.productsByIds(lines.map((l) => l.productId));
    const live = new Set(products.filter((p) => !p.archivedAt).map((p) => p.id));
    const costs = await currentCosts(asTenantDb(this.db), [...new Set(lines.map((l) => l.itemId))]);
    const byProduct = new Map<string, typeof lines>();
    for (const line of lines) {
      if (!live.has(line.productId)) continue;
      byProduct.set(line.productId, [...(byProduct.get(line.productId) ?? []), line]);
    }
    return [...byProduct].map(([productId, recipe]) => {
      let total = new Decimal(0);
      let complete = true;
      const out = recipe.map((line) => {
        const quantity = new Decimal(line.quantity.toFixed(3));
        const unitCost = costs.get(line.itemId) ?? null;
        if (unitCost === null) complete = false;
        else total = total.plus(quantity.times(unitCost));
        return {
          itemId: line.itemId,
          quantity: quantity.toFixed(3),
          unitCost: unitCost === null ? null : costText(unitCost),
        };
      });
      return {
        productId,
        cost: valueOf(total, new Decimal(1)).toFixed(2),
        complete,
        lines: out,
      };
    });
  }

  /** The product, archived ones too; another tenant's or an unknown one is 404. */
  private async product(productId: string) {
    const [product] = await this.catalog.productsByIds([productId]);
    if (!product) throw inventoryErrors.productNotFound();
    return product;
  }
}

async function recipeOf(db: Db, productId: string): Promise<Recipe> {
  const lines = await db.recipeLine.findMany({
    where: { productId },
    select: {
      itemId: true,
      quantity: true,
      item: { select: { name: true, unit: true } },
    },
    orderBy: [{ item: { name: 'asc' } }, { id: 'asc' }],
  });
  return {
    productId,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      itemName: l.item.name,
      unit: l.item.unit,
      quantity: l.quantity.toFixed(3),
    })),
  };
}

/**
 * Each item's current cost per unit: the weighted average over warehouses with stock on hand,
 * else its last movement's unit cost; items never moved are left out (ADR 0028 §2).
 */
async function currentCosts(db: Db, itemIds: string[]): Promise<Map<string, Decimal>> {
  if (itemIds.length === 0) return new Map();
  const [onHand, last] = await Promise.all([
    db.$queryRaw<{ item_id: string; cost: string }[]>`
      SELECT item_id::text, (sum(quantity * average_cost) / sum(quantity))::text AS cost
      FROM stock_levels
      WHERE quantity > 0 AND item_id = ANY(${itemIds}::uuid[])
      GROUP BY item_id`,
    db.$queryRaw<{ item_id: string; cost: string }[]>`
      SELECT DISTINCT ON (item_id) item_id::text, unit_cost::text AS cost
      FROM stock_movements
      WHERE item_id = ANY(${itemIds}::uuid[])
      ORDER BY item_id, created_at DESC, id DESC`,
  ]);
  const costs = new Map<string, Decimal>();
  for (const row of last) costs.set(row.item_id, new Decimal(row.cost));
  for (const row of onHand) costs.set(row.item_id, new Decimal(row.cost));
  return costs;
}

/** Flat snapshot (ADR 0008): the product, how many lines and which items. */
function recipeSnapshot(productId: string, lines: { itemId: string }[]) {
  return snapshot('recipe', {
    productId,
    lineCount: lines.length,
    itemIds: lines
      .map((l) => l.itemId)
      .sort()
      .join(','),
  });
}
