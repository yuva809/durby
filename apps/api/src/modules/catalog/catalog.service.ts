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
import { catalogErrors, isUniqueViolation } from './catalog-errors';
import { fixed2 } from './decimal-text';

const CATEGORY_SELECT = { id: true, name: true, sortOrder: true, archivedAt: true } as const;

const PRODUCT_SELECT = {
  id: true,
  categoryId: true,
  name: true,
  description: true,
  price: true,
  taxRate: true,
  sortOrder: true,
  archivedAt: true,
} as const;

type CategoryRow = { id: string; name: string; sortOrder: number; archivedAt: Date | null };

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
          data: { tenantId, name: body.name, sortOrder: body.sortOrder ?? 0 },
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
        const row = await tx.product.create({
          data: {
            tenantId,
            categoryId: body.categoryId,
            name: body.name,
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
          description:
            body.description === undefined ? before.description : body.description || null,
          price: body.price === undefined ? before.price : fixed2(body.price),
          taxRate: body.taxRate === undefined ? before.taxRate : fixed2(body.taxRate),
          sortOrder: body.sortOrder ?? before.sortOrder,
        };
        const nextArchivedAt = archivedAt(current.archivedAt, body.archived);
        next.archivedAt = nextArchivedAt?.toISOString() ?? null;
        if (JSON.stringify(next) === JSON.stringify(before)) return before;

        const row = await tx.product.update({
          where: { id },
          data: {
            categoryId: next.categoryId,
            name: next.name,
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
                data: { tenantId, name: categoryName, sortOrder: 0 },
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
            if (!current) {
              const row = await tx.product.create({
                data: {
                  tenantId,
                  categoryId: category.id,
                  name,
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
              before.description === description
            ) {
              response.unchanged += 1;
              response.rows.push({ row: index + 1, status: 'unchanged', productId: current.id });
              continue;
            }
            const row = await tx.product.update({
              where: { id: current.id },
              data: { price, taxRate, description },
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
      if (isUniqueViolation(error)) throw taken();
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
