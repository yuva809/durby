import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditActor,
  checkImportRows,
  type CreateProductCategoryRequest,
  type CreateProductRequest,
  type ImportProductsRequest,
  type ImportProductsResponse,
  type ListProductCategoriesQuery,
  type ListProductsQuery,
  type NumberProductsResponse,
  type PrepStation,
  type Product,
  type ProductCategory,
  type UpdateProductCategoryRequest,
  type UpdateProductRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { catalogErrors, isUniqueViolation, violates } from './catalog-errors';
import { fixed2 } from './decimal-text';

const CATEGORY_SELECT = {
  id: true,
  name: true,
  sortOrder: true,
  station: true,
  archivedAt: true,
} as const;

const PRODUCT_SELECT = {
  id: true,
  categoryId: true,
  name: true,
  menuNumber: true,
  description: true,
  price: true,
  taxRate: true,
  sortOrder: true,
  archivedAt: true,
} as const;

type CategoryRow = {
  id: string;
  name: string;
  sortOrder: number;
  station: PrepStation;
  archivedAt: Date | null;
};

/** Prisma returns `numeric` columns as Decimal objects; only their exact text is used here. */
type DecimalValue = { toFixed(digits: number): string };

type ProductRow = Omit<Product, 'price' | 'taxRate' | 'archivedAt'> & {
  price: DecimalValue;
  taxRate: DecimalValue;
  archivedAt: Date | null;
};

/**
 * Categories and products (docs/modules/catalog.md). Every change and its audit row share one
 * tenant transaction; creates also store their idempotent result there (rule 8). A change that
 * changes nothing writes nothing.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listCategories(query: ListProductCategoriesQuery): Promise<ProductCategory[]> {
    const rows = await this.db.productCategory.findMany({
      where: query.includeArchived ? {} : { archivedAt: null },
      select: CATEGORY_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(categoryResponse);
  }

  /** `actor`: the signed-in user, or a system actor for bootstrap commands (seed-dev). */
  async createCategory(
    body: CreateProductCategoryRequest,
    actor?: AuditActor,
  ): Promise<ProductCategory> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.unique(catalogErrors.categoryNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const row = await tx.productCategory.create({
          data: {
            tenantId,
            name: body.name,
            sortOrder: body.sortOrder ?? 0,
            station: body.station ?? 'kitchen',
          },
          select: CATEGORY_SELECT,
        });
        await this.audit.record(tx, {
          action: 'catalog.product_category.created',
          actor: actor ?? auditActor.user(userId),
          entityId: row.id,
          after: categorySnapshot(row),
        });
        const response = categoryResponse(row);
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async updateCategory(id: string, body: UpdateProductCategoryRequest): Promise<ProductCategory> {
    const { userId } = this.tenantContext.require();
    return this.unique(catalogErrors.categoryNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const current = await tx.productCategory.findUnique({
          where: { id },
          select: CATEGORY_SELECT,
        });
        if (!current) throw catalogErrors.categoryNotFound();
        const data = {
          name: body.name ?? current.name,
          sortOrder: body.sortOrder ?? current.sortOrder,
          station: body.station ?? current.station,
          archivedAt: archivedAt(current.archivedAt, body.archived),
        };
        if (sameSnapshot(categorySnapshot(current), categorySnapshot({ ...current, ...data }))) {
          return categoryResponse(current);
        }
        const row = await tx.productCategory.update({
          where: { id },
          data,
          select: CATEGORY_SELECT,
        });
        await this.audit.record(tx, {
          action: 'catalog.product_category.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before: categorySnapshot(current),
          after: categorySnapshot(row),
        });
        return categoryResponse(row);
      }),
    );
  }

  /** Products by id, archived ones too, for other modules (inventory recipes, ADR 0028). */
  async productsByIds(ids: readonly string[]): Promise<Product[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.product.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: PRODUCT_SELECT,
    });
    return rows.map(productResponse);
  }

  async listProducts(query: ListProductsQuery): Promise<Product[]> {
    const rows = await this.db.product.findMany({
      where: {
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      select: PRODUCT_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(productResponse);
  }

  async createProduct(body: CreateProductRequest, actor?: AuditActor): Promise<Product> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.unique(catalogErrors.productNameTaken, () =>
      this.db.$transaction(async (tx) => {
        await this.openCategory(tx, body.categoryId);
        if (body.menuNumber) await this.freeMenuNumber(tx, body.menuNumber, null);
        const row = await tx.product.create({
          data: {
            tenantId,
            categoryId: body.categoryId,
            name: body.name,
            menuNumber: body.menuNumber ?? null,
            description: body.description || null,
            price: body.price,
            taxRate: body.taxRate,
            sortOrder: body.sortOrder ?? 0,
          },
          select: PRODUCT_SELECT,
        });
        await this.audit.record(tx, {
          action: 'catalog.product.created',
          actor: actor ?? auditActor.user(userId),
          entityId: row.id,
          after: productSnapshot(row),
        });
        const response = productResponse(row);
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async updateProduct(id: string, body: UpdateProductRequest): Promise<Product> {
    const { userId } = this.tenantContext.require();
    return this.unique(catalogErrors.productNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const current = await tx.product.findUnique({ where: { id }, select: PRODUCT_SELECT });
        if (!current) throw catalogErrors.productNotFound();
        if (body.categoryId !== undefined && body.categoryId !== current.categoryId) {
          await this.openCategory(tx, body.categoryId);
        }
        const before = productResponse(current);
        const next: Product = {
          ...before,
          categoryId: body.categoryId ?? before.categoryId,
          name: body.name ?? before.name,
          menuNumber: body.menuNumber === undefined ? before.menuNumber : body.menuNumber,
          description:
            body.description === undefined ? before.description : body.description || null,
          price: body.price === undefined ? before.price : fixed2(body.price),
          taxRate: body.taxRate === undefined ? before.taxRate : fixed2(body.taxRate),
          sortOrder: body.sortOrder ?? before.sortOrder,
        };
        const nextArchivedAt = archivedAt(current.archivedAt, body.archived);
        next.archivedAt = nextArchivedAt?.toISOString() ?? null;
        if (JSON.stringify(next) === JSON.stringify(before)) return before;
        // A new number, or a restored product taking its number back: it must be free.
        if (next.menuNumber && next.archivedAt === null) {
          await this.freeMenuNumber(tx, next.menuNumber, id);
        }

        const row = await tx.product.update({
          where: { id },
          data: {
            categoryId: next.categoryId,
            name: next.name,
            menuNumber: next.menuNumber,
            description: next.description,
            price: next.price,
            taxRate: next.taxRate,
            sortOrder: next.sortOrder,
            archivedAt: nextArchivedAt,
          },
          select: PRODUCT_SELECT,
        });
        await this.audit.record(tx, {
          action: 'catalog.product.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before: productSnapshot(current),
          after: productSnapshot(row),
        });
        return productResponse(row);
      }),
    );
  }

  /**
   * The CSV import (docs/modules/catalog.md → Import): all rows checked first, then one transaction
   * that creates missing categories, creates new products and updates changed ones. Matching is by
   * name among non-archived rows, case-insensitive; products missing from the file are untouched.
   */
  async importProducts(body: ImportProductsRequest): Promise<ImportProductsResponse> {
    const problems = checkImportRows(body.rows);
    if (problems.length > 0) throw catalogErrors.importInvalid(problems);
    const { tenantId, userId } = this.tenantContext.require();
    const actor = auditActor.user(userId);
    return this.unique(catalogErrors.productNameTaken, () =>
      this.db.$transaction(
        async (tx) => {
          const categories = new Map(
            (
              await tx.productCategory.findMany({
                where: { archivedAt: null },
                select: CATEGORY_SELECT,
              })
            ).map((c) => [c.name.toLowerCase(), c]),
          );
          const products = new Map(
            (
              await tx.product.findMany({ where: { archivedAt: null }, select: PRODUCT_SELECT })
            ).map((p) => [productKey(p.categoryId, p.name), p]),
          );
          const response: ImportProductsResponse = {
            created: 0,
            updated: 0,
            unchanged: 0,
            categoriesCreated: 0,
            rows: [],
          };

          for (const [index, input] of body.rows.entries()) {
            const categoryName = input.category.trim();
            let category = categories.get(categoryName.toLowerCase());
            if (!category) {
              category = await tx.productCategory.create({
                data: {
                  tenantId,
                  name: categoryName,
                  sortOrder: 0,
                  ...(input.station && { station: input.station }),
                },
                select: CATEGORY_SELECT,
              });
              await this.audit.record(tx, {
                action: 'catalog.product_category.created',
                actor,
                entityId: category.id,
                after: categorySnapshot(category),
              });
              categories.set(categoryName.toLowerCase(), category);
              response.categoriesCreated += 1;
            }

            const name = input.name.trim();
            const price = fixed2(input.price.trim());
            const taxRate = fixed2(input.taxRate.trim());
            const key = productKey(category.id, name);
            const current = products.get(key);
            // An empty number cell keeps the product's number (ADR 0029).
            const menuNumber = input.number?.trim() || (current?.menuNumber ?? null);
            if (menuNumber && menuNumber !== current?.menuNumber) {
              await this.freeMenuNumber(tx, menuNumber, current?.id ?? null);
            }
            if (!current) {
              const row = await tx.product.create({
                data: {
                  tenantId,
                  categoryId: category.id,
                  name,
                  menuNumber,
                  description: input.description?.trim() || null,
                  price,
                  taxRate,
                  sortOrder: 0,
                },
                select: PRODUCT_SELECT,
              });
              await this.audit.record(tx, {
                action: 'catalog.product.created',
                actor,
                entityId: row.id,
                after: productSnapshot(row),
              });
              products.set(key, row);
              response.created += 1;
              response.rows.push({ row: index + 1, status: 'created', productId: row.id });
              continue;
            }

            const before = productResponse(current);
            // No description column in the file: the product keeps its description.
            const description =
              input.description === undefined
                ? before.description
                : input.description.trim() || null;
            if (
              before.price === price &&
              before.taxRate === taxRate &&
              before.description === description &&
              before.menuNumber === menuNumber
            ) {
              response.unchanged += 1;
              response.rows.push({ row: index + 1, status: 'unchanged', productId: current.id });
              continue;
            }
            const row = await tx.product.update({
              where: { id: current.id },
              data: { price, taxRate, description, menuNumber },
              select: PRODUCT_SELECT,
            });
            await this.audit.record(tx, {
              action: 'catalog.product.updated',
              actor,
              entityId: row.id,
              before: productSnapshot(current),
              after: productSnapshot(row),
            });
            products.set(key, row);
            response.updated += 1;
            response.rows.push({ row: index + 1, status: 'updated', productId: row.id });
          }

          await this.idempotency.completeInTransaction(tx, response);
          return response;
        },
        // Up to CATALOG_IMPORT_MAX_ROWS rows, each with its audit row: more than the 5 s default.
        { maxWait: 10_000, timeout: 60_000 },
      ),
    );
  }

  /**
   * "Fill missing numbers" (ADR 0029): every non-archived product without a number gets the next
   * integer above the highest numeric number in use, in menu order. The unique index backs a
   * concurrent manual edit.
   */
  async numberProducts(): Promise<NumberProductsResponse> {
    const { userId } = this.tenantContext.require();
    const actor = auditActor.user(userId);
    return this.unique(catalogErrors.productNameTaken, () =>
      this.db.$transaction(
        async (tx) => {
          const [top] = await tx.$queryRaw<{ highest: number | null }[]>`
            SELECT max(menu_number::int) AS highest FROM products
            WHERE archived_at IS NULL AND menu_number ~ '^[0-9]{1,6}$'`;
          const unnumbered = await tx.product.findMany({
            where: { archivedAt: null, menuNumber: null },
            select: PRODUCT_SELECT,
            orderBy: [
              { category: { sortOrder: 'asc' } },
              { category: { name: 'asc' } },
              { sortOrder: 'asc' },
              { name: 'asc' },
              { id: 'asc' },
            ],
          });
          let next = (top?.highest ?? 0) + 1;
          for (const current of unnumbered) {
            // "012" counts as 12 for the highest but is not the text "12": skip taken texts too.
            while (await this.menuNumberUsed(tx, String(next), null)) next += 1;
            const row = await tx.product.update({
              where: { id: current.id },
              data: { menuNumber: String(next) },
              select: PRODUCT_SELECT,
            });
            await this.audit.record(tx, {
              action: 'catalog.product.updated',
              actor,
              entityId: row.id,
              before: productSnapshot(current),
              after: productSnapshot(row),
            });
            next += 1;
          }
          const response: NumberProductsResponse = { numbered: unnumbered.length };
          await this.idempotency.completeInTransaction(tx, response);
          return response;
        },
        { maxWait: 10_000, timeout: 60_000 },
      ),
    );
  }

  /** Another non-archived product has this number (case-insensitive): 409. */
  private async freeMenuNumber(
    tx: TenantTransactionClient,
    menuNumber: string,
    exceptId: string | null,
  ): Promise<void> {
    if (await this.menuNumberUsed(tx, menuNumber, exceptId)) throw catalogErrors.menuNumberTaken();
  }

  private async menuNumberUsed(
    tx: TenantTransactionClient,
    menuNumber: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const other = await tx.product.findFirst({
      where: {
        archivedAt: null,
        menuNumber: { equals: menuNumber, mode: 'insensitive' },
        ...(exceptId && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return other !== null;
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

  private async unique<T>(taken: () => Error, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw violates(error, 'menu_number') ? catalogErrors.menuNumberTaken() : taken();
      }
      throw error;
    }
  }
}

/** `archived`: true archives (keeping the first archive time), false restores, absent keeps. */
function archivedAt(current: Date | null, archived: boolean | undefined): Date | null {
  if (archived === undefined) return current;
  if (!archived) return null;
  return current ?? new Date();
}

/** A product's identity for the import: its category and its name, case-insensitive. */
function productKey(categoryId: string, name: string): string {
  return `${categoryId}:${name.toLowerCase()}`;
}

function categoryResponse(row: CategoryRow): ProductCategory {
  return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null };
}

function productResponse(row: ProductRow): Product {
  return {
    ...row,
    price: row.price.toFixed(2),
    taxRate: row.taxRate.toFixed(2),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function categorySnapshot(row: CategoryRow) {
  return snapshot('product_category', row);
}

/** `description` is free text and not in the allow-list, so snapshot() drops it. */
function productSnapshot(row: ProductRow) {
  return snapshot('product', productResponse(row));
}

function sameSnapshot(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
