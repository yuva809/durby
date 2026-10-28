import {
  type CreateProductCategoryRequest,
  type CreateProductRequest,
  type Product,
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
