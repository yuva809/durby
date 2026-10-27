import { z } from 'zod';

/** Request and response bodies of /api/v1/catalog (docs/modules/catalog.md). */

/** Category and product names. */
export const CATALOG_NAME_MAX_LENGTH = 100;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 500;

const name = (max: number) => z.string().trim().min(1).max(max);
const sortOrder = z.int().min(0).max(1_000_000);

/**
 * Money and rates are decimal strings (CLAUDE.md rule 6), never JSON numbers. `price`: gross, up to
 * 10 integer digits and 2 decimals (`numeric(12,2)`). `taxRate`: a percentage in [0, 100].
 */
export const priceSchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Invalid amount');
export const taxRateSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Invalid rate')
  .refine((value) => Number(value) <= 100, 'Invalid rate');

export const productCategorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sortOrder: z.int(),
  archivedAt: z.iso.datetime().nullable(),
});

export const productSchema = z.object({
  id: z.uuid(),
  categoryId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /** Always two decimals, e.g. `"12.50"`. */
  price: z.string(),
  /** Always two decimals, e.g. `"7.00"`. */
  taxRate: z.string(),
  sortOrder: z.int(),
  archivedAt: z.iso.datetime().nullable(),
});

export const createProductCategoryRequestSchema = z.strictObject({
  name: name(CATALOG_NAME_MAX_LENGTH),
  sortOrder: sortOrder.optional(),
});

export const updateProductCategoryRequestSchema = z
  .strictObject({
    name: name(CATALOG_NAME_MAX_LENGTH).optional(),
    sortOrder: sortOrder.optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

const description = z.string().trim().max(PRODUCT_DESCRIPTION_MAX_LENGTH);

export const createProductRequestSchema = z.strictObject({
  categoryId: z.uuid(),
  name: name(CATALOG_NAME_MAX_LENGTH),
  /** Empty means none. */
  description: description.optional(),
  price: priceSchema,
  taxRate: taxRateSchema,
  sortOrder: sortOrder.optional(),
});

export const updateProductRequestSchema = z
  .strictObject({
    categoryId: z.uuid().optional(),
    name: name(CATALOG_NAME_MAX_LENGTH).optional(),
    description: description.optional(),
    price: priceSchema.optional(),
    taxRate: taxRateSchema.optional(),
    sortOrder: sortOrder.optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

const includeArchived = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

export const listProductCategoriesQuerySchema = z.object({ includeArchived });
export const listProductsQuerySchema = z.object({
  categoryId: z.uuid().optional(),
  includeArchived,
});

export const productCategoryListResponseSchema = z.object({
  data: z.array(productCategorySchema),
});
export const productListResponseSchema = z.object({ data: z.array(productSchema) });

export type ProductCategory = z.infer<typeof productCategorySchema>;
export type Product = z.infer<typeof productSchema>;
export type CreateProductCategoryRequest = z.infer<typeof createProductCategoryRequestSchema>;
export type UpdateProductCategoryRequest = z.infer<typeof updateProductCategoryRequestSchema>;
export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;
export type UpdateProductRequest = z.infer<typeof updateProductRequestSchema>;
export type ListProductCategoriesQuery = z.infer<typeof listProductCategoriesQuerySchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type ProductCategoryListResponse = z.infer<typeof productCategoryListResponseSchema>;
export type ProductListResponse = z.infer<typeof productListResponseSchema>;

/** Stable error codes of the catalog endpoints; the web app shows the matching label. */
export const CATALOG_ERROR_CODES = [
  'catalog.category_not_found',
  'catalog.product_not_found',
  'catalog.category_name_taken',
  'catalog.product_name_taken',
  'catalog.category_archived',
] as const;

export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];

/** `catalog.category_not_found` → `catalog.errors.categoryNotFound`. */
export function catalogErrorLabel(code: CatalogErrorCode): string {
  return `catalog.errors.${code.slice('catalog.'.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
