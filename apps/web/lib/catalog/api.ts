import {
  type CategoryBulkRequest,
  type CategoryBulkResponse,
  categoryBulkResponseSchema,
  type CreateProductCategoryRequest,
  type CreateProductRequest,
  type ImportProductRow,
  type ImportProductsResponse,
  importProductsResponseSchema,
  type NumberProductsResponse,
  numberProductsResponseSchema,
  type RenumberProductsResponse,
  renumberProductsResponseSchema,
  type Product,
  type ProductBulkRequest,
  type ProductBulkResponse,
  productBulkResponseSchema,
  type ProductCategory,
  productCategoryListResponseSchema,
  productCategorySchema,
  productListResponseSchema,
  productSchema,
  type UpdateProductCategoryRequest,
  type UpdateProductRequest,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of the products page (docs/modules/catalog.md → API), parsed with the shared schemas. */

const archived = (includeArchived: boolean) => (includeArchived ? '?includeArchived=true' : '');

export const loadCategories = (
  store: Api,
  includeArchived = false,
): Promise<Result<ProductCategory[]>> =>
  read(
    store,
    `/api/v1/catalog/categories${archived(includeArchived)}`,
    list(productCategoryListResponseSchema),
  );

export const loadProducts = (store: Api, includeArchived = false): Promise<Result<Product[]>> =>
  read(
    store,
    `/api/v1/catalog/products${archived(includeArchived)}`,
    list(productListResponseSchema),
  );

export const createCategory = (
  store: Api,
  action: ActionKey,
  body: CreateProductCategoryRequest,
): Promise<Result<ProductCategory | null>> =>
  write(store, action, '/api/v1/catalog/categories', 'POST', body, productCategorySchema);

export const updateCategory = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateProductCategoryRequest,
): Promise<Result<ProductCategory | null>> =>
  write(store, action, `/api/v1/catalog/categories/${id}`, 'PATCH', body, productCategorySchema);

export const createProduct = (
  store: Api,
  action: ActionKey,
  body: CreateProductRequest,
): Promise<Result<Product | null>> =>
  write(store, action, '/api/v1/catalog/products', 'POST', body, productSchema);

export const updateProduct = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateProductRequest,
): Promise<Result<Product | null>> =>
  write(store, action, `/api/v1/catalog/products/${id}`, 'PATCH', body, productSchema);

/** The CSV import: rows read in the browser (docs/modules/catalog.md → Import). */
export const importProducts = (
  store: Api,
  action: ActionKey,
  rows: ImportProductRow[],
): Promise<Result<ImportProductsResponse | null>> =>
  write(
    store,
    action,
    '/api/v1/catalog/products/import',
    'POST',
    { rows },
    importProductsResponseSchema,
  );

/** Fill missing numbers (ADR 0029). */
export const numberProducts = (
  store: Api,
  action: ActionKey,
): Promise<Result<NumberProductsResponse | null>> =>
  write(
    store,
    action,
    '/api/v1/catalog/products/number',
    'POST',
    undefined,
    numberProductsResponseSchema,
  );

/** Saves the drag-and-drop order of the categories (ADR 0043); answers them in the new order. */
export const orderCategories = (store: Api, action: ActionKey, categoryIds: string[]) =>
  write(
    store,
    action,
    '/api/v1/catalog/categories/order',
    'POST',
    { categoryIds },
    list(productCategoryListResponseSchema),
  );

/** Renumber the whole menu 1…N in menu order (ADR 0043). */
export const renumberProducts = (
  store: Api,
  action: ActionKey,
): Promise<Result<RenumberProductsResponse | null>> =>
  write(
    store,
    action,
    '/api/v1/catalog/products/renumber',
    'POST',
    undefined,
    renumberProductsResponseSchema,
  );

/** Bulk actions on the selected products or categories (docs/modules/catalog.md → Bulk actions). */
export const bulkProducts = (
  store: Api,
  action: ActionKey,
  body: ProductBulkRequest,
): Promise<Result<ProductBulkResponse | null>> =>
  write(store, action, '/api/v1/catalog/products/bulk', 'POST', body, productBulkResponseSchema);

export const bulkCategories = (
  store: Api,
  action: ActionKey,
  body: CategoryBulkRequest,
): Promise<Result<CategoryBulkResponse | null>> =>
  write(store, action, '/api/v1/catalog/categories/bulk', 'POST', body, categoryBulkResponseSchema);
