import { Inject, Injectable } from '@nestjs/common';
import {
  type CategoryBulkRequest,
  type CategoryBulkResponse,
  newPrice,
  type PrepStation,
  type ProductBulkAction,
  type ProductBulkRequest,
  type ProductBulkResponse,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { catalogErrors, isForeignKeyViolation, isUniqueViolation } from './catalog-errors';
import { fixed2 } from './decimal-text';

const PRODUCT_SELECT = {
  id: true,
  categoryId: true,
  name: true,
  price: true,
  taxRate: true,
  sortOrder: true,
  archivedAt: true,
} as const;
const CATEGORY_SELECT = {
  id: true,
  name: true,
  sortOrder: true,
  station: true,
  archivedAt: true,
} as const;

type ProductRow = {
  id: string;
  categoryId: string;
  name: string;
  price: { toFixed(digits: number): string };
  taxRate: { toFixed(digits: number): string };
  sortOrder: number;
  archivedAt: Date | null;
};
type CategoryRow = {
  id: string;
  name: string;
  sortOrder: number;
  station: PrepStation;
  archivedAt: Date | null;
};

/** Up to 500 rows, each with its audit row: more than the 5 s default (as the import). */
const LONG = { maxWait: 10_000, timeout: 60_000 };

/**
 * Bulk actions (docs/modules/catalog.md → Bulk actions). Edits are all or nothing in one
 * transaction. Deletes remove only rows nothing refers to: an order line references its product
 * with ON DELETE RESTRICT, so a sold product can't be deleted. Each delete runs in its own
 * savepoint and a refused one is reported as `sold`, without catalog reading POS tables (rule 4).
 */
@Injectable()
export class CatalogBulkService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async products(body: ProductBulkRequest): Promise<ProductBulkResponse> {
    const { userId } = this.tenantContext.require();
    const actor = auditActor.user(userId);
    const ids = [...new Set(body.ids)];
    const run = () =>
      this.db.$transaction(async (tx) => {
        const response =
          body.action.kind === 'delete'
            ? await this.deleteProducts(tx, ids, actor)
            : await this.editProducts(tx, ids, body.action, actor);
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }, LONG);
    try {
      return await run();
    } catch (error) {
      // A moved or restored product whose name the category already has (partial unique index).
      if (isUniqueViolation(error)) throw catalogErrors.productNameTaken();
      throw error;
    }
  }

  async categories(body: CategoryBulkRequest): Promise<CategoryBulkResponse> {
    const { userId } = this.tenantContext.require();
    const actor = auditActor.user(userId);
    const ids = [...new Set(body.ids)];
    try {
      return await this.db.$transaction(async (tx) => {
        const response =
          body.action === 'delete'
            ? await this.deleteCategories(tx, ids, actor)
            : {
                ...(await this.archiveCategories(tx, ids, body.action, actor)),
                productsDeleted: 0,
              };
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }, LONG);
    } catch (error) {
      if (isUniqueViolation(error)) throw catalogErrors.categoryNameTaken();
      throw error;
    }
  }

  private async editProducts(
    tx: TenantTransactionClient,
    ids: string[],
    action: Exclude<ProductBulkAction, { kind: 'delete' }>,
    actor: ReturnType<typeof auditActor.user>,
  ): Promise<ProductBulkResponse> {
    const rows: ProductRow[] = await tx.product.findMany({
      where: { id: { in: ids } },
      select: PRODUCT_SELECT,
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw catalogErrors.productsNotFound(missing);

    if (action.kind === 'move') await this.openCategory(tx, action.categoryId);
    let prices: Map<string, string | null> | null = null;
    if (action.kind === 'price') {
      prices = new Map(rows.map((r) => [r.id, newPrice(r.price.toFixed(2), action.change)]));
      const invalid = rows.filter((r) => prices?.get(r.id) === null).map((r) => r.id);
      if (invalid.length > 0) throw catalogErrors.priceInvalid(invalid);
    }

    const now = new Date();
    const updated: string[] = [];
    for (const row of rows) {
      const data = changeOf(row, action, prices, now);
      if (data === null) continue;
      const next: ProductRow = await tx.product.update({
        where: { id: row.id },
        data,
        select: PRODUCT_SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.product.updated',
        actor,
        entityId: row.id,
        before: productSnapshot(row),
        after: productSnapshot(next),
      });
      updated.push(row.id);
    }
    return { updated, deleted: [], kept: [] };
  }

  private async deleteProducts(
    tx: TenantTransactionClient,
    ids: string[],
    actor: ReturnType<typeof auditActor.user>,
  ): Promise<ProductBulkResponse> {
    const rows: ProductRow[] = await tx.product.findMany({
      where: { id: { in: ids } },
      select: PRODUCT_SELECT,
    });
    const deleted: string[] = [];
    const kept: ProductBulkResponse['kept'] = [];
    for (const row of rows) {
      const ok = await savepoint(tx, async () => {
        await tx.product.delete({ where: { id: row.id } });
        await this.audit.record(tx, {
          action: 'catalog.product.deleted',
          actor,
          entityId: row.id,
          before: productSnapshot(row),
        });
      });
      if (ok) deleted.push(row.id);
      else kept.push({ id: row.id, reason: 'sold' });
    }
    return { updated: [], deleted, kept };
  }

  private async archiveCategories(
    tx: TenantTransactionClient,
    ids: string[],
    action: 'archive' | 'restore',
    actor: ReturnType<typeof auditActor.user>,
  ): Promise<{ updated: string[]; deleted: string[]; kept: CategoryBulkResponse['kept'] }> {
    const rows: CategoryRow[] = await tx.productCategory.findMany({
      where: { id: { in: ids } },
      select: CATEGORY_SELECT,
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw catalogErrors.categoriesNotFound(missing);
    const now = new Date();
    const updated: string[] = [];
    for (const row of rows) {
      const archived = row.archivedAt !== null;
      if (archived === (action === 'archive')) continue;
      const next: CategoryRow = await tx.productCategory.update({
        where: { id: row.id },
        data: { archivedAt: action === 'archive' ? now : null },
        select: CATEGORY_SELECT,
      });
      await this.audit.record(tx, {
        action: 'catalog.product_category.updated',
        actor,
        entityId: row.id,
        before: categorySnapshot(row),
        after: categorySnapshot(next),
      });
      updated.push(row.id);
    }
    return { updated, deleted: [], kept: [] };
  }

  /** A category with all its products, or nothing of it when one of them was sold. */
  private async deleteCategories(
    tx: TenantTransactionClient,
    ids: string[],
    actor: ReturnType<typeof auditActor.user>,
  ): Promise<CategoryBulkResponse> {
    const rows: CategoryRow[] = await tx.productCategory.findMany({
      where: { id: { in: ids } },
      select: CATEGORY_SELECT,
    });
    const deleted: string[] = [];
    const kept: CategoryBulkResponse['kept'] = [];
    let productsDeleted = 0;
    for (const row of rows) {
      let count = 0;
      const ok = await savepoint(tx, async () => {
        const products: ProductRow[] = await tx.product.findMany({
          where: { categoryId: row.id },
          select: PRODUCT_SELECT,
        });
        for (const product of products) {
          await tx.product.delete({ where: { id: product.id } });
          await this.audit.record(tx, {
            action: 'catalog.product.deleted',
            actor,
            entityId: product.id,
            before: productSnapshot(product),
          });
        }
        await tx.productCategory.delete({ where: { id: row.id } });
        await this.audit.record(tx, {
          action: 'catalog.product_category.deleted',
          actor,
          entityId: row.id,
          before: categorySnapshot(row),
        });
        count = products.length;
      });
      if (ok) {
        deleted.push(row.id);
        productsDeleted += count;
      } else {
        kept.push({ id: row.id, reason: 'sold' });
      }
    }
    return { updated: [], deleted, kept, productsDeleted };
  }

  /** The category exists in this tenant (RLS) and isn't archived. */
  private async openCategory(tx: TenantTransactionClient, id: string): Promise<void> {
    const category = await tx.productCategory.findUnique({
      where: { id },
      select: { archivedAt: true },
    });
    if (!category) throw catalogErrors.categoryNotFound();
    if (category.archivedAt) throw catalogErrors.categoryArchived();
  }
}

let savepoints = 0;

/**
 * Runs `fn` in a savepoint of `tx`: true when it went through; false, rolled back to the savepoint,
 * when the database refused it for a foreign key (something still refers to the row). Any other
 * error propagates and fails the whole transaction.
 */
async function savepoint(tx: TenantTransactionClient, fn: () => Promise<void>): Promise<boolean> {
  const name = `bulk_${++savepoints}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return true;
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error;
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    return false;
  }
}

/** The update for one product, or null when it is already as asked. */
function changeOf(
  row: ProductRow,
  action: Exclude<ProductBulkAction, { kind: 'delete' }>,
  prices: Map<string, string | null> | null,
  now: Date,
): { archivedAt?: Date | null; categoryId?: string; taxRate?: string; price?: string } | null {
  switch (action.kind) {
    case 'archive':
      return row.archivedAt === null ? { archivedAt: now } : null;
    case 'restore':
      return row.archivedAt !== null ? { archivedAt: null } : null;
    case 'move':
      return row.categoryId !== action.categoryId ? { categoryId: action.categoryId } : null;
    case 'vat': {
      const taxRate = fixed2(action.taxRate);
      return row.taxRate.toFixed(2) !== taxRate ? { taxRate } : null;
    }
    case 'price': {
      const price = prices?.get(row.id) ?? null;
      return price !== null && price !== row.price.toFixed(2) ? { price } : null;
    }
  }
}

/** As CatalogService: `description` stays out of snapshots. */
function productSnapshot(row: ProductRow) {
  return snapshot('product', {
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    price: row.price.toFixed(2),
    taxRate: row.taxRate.toFixed(2),
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  });
}

function categorySnapshot(row: CategoryRow) {
  return snapshot('product_category', row);
}
