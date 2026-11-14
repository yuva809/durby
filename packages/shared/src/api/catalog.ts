import { z } from 'zod';

/** Request and response bodies of /api/v1/catalog (docs/modules/catalog.md). */

/** Category and product names. */
export const CATALOG_NAME_MAX_LENGTH = 100;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 500;

const name = (max: number) => z.string().trim().min(1).max(max);
const sortOrder = z.int().min(0).max(1_000_000);

/** Where a category's items are prepared: each station gets its own ticket (ADR 0025). */
export const PREP_STATIONS = ['kitchen', 'bar'] as const;
export type PrepStation = (typeof PREP_STATIONS)[number];

/**
 * Money and rates are decimal strings (CLAUDE.md rule 6), never JSON numbers. `price`: gross, up to
 * 10 integer digits and 2 decimals (`numeric(12,2)`). `taxRate`: a percentage in [0, 100].
 */
export const priceSchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Invalid amount');
/** A dish's number on the menu (ADR 0029): `12`, `12a`, `D4`, `B-3`. */
export const MENU_NUMBER_MAX_LENGTH = 6;
export const menuNumberSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,5}$/, 'Invalid menu number');

export const taxRateSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Invalid rate')
  .refine((value) => Number(value) <= 100, 'Invalid rate');

export const productCategorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sortOrder: z.int(),
  station: z.enum(PREP_STATIONS),
  archivedAt: z.iso.datetime().nullable(),
});

export const productSchema = z.object({
  id: z.uuid(),
  categoryId: z.uuid(),
  name: z.string(),
  /** Its number on the menu (ADR 0029); unique in the organization. */
  menuNumber: z.string().nullable(),
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
  station: z.enum(PREP_STATIONS).optional(),
});

export const updateProductCategoryRequestSchema = z
  .strictObject({
    name: name(CATALOG_NAME_MAX_LENGTH).optional(),
    sortOrder: sortOrder.optional(),
    station: z.enum(PREP_STATIONS).optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

const description = z.string().trim().max(PRODUCT_DESCRIPTION_MAX_LENGTH);

export const createProductRequestSchema = z.strictObject({
  categoryId: z.uuid(),
  name: name(CATALOG_NAME_MAX_LENGTH),
  menuNumber: menuNumberSchema.optional(),
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
    /** null clears it. */
    menuNumber: menuNumberSchema.nullable().optional(),
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

/**
 * Import (docs/modules/catalog.md → Import): rows read from a CSV file in the browser. The request
 * takes raw strings; `checkImportRows` applies the same rules as a single product, so the web
 * preview and the api agree on every problem.
 */
export const CATALOG_IMPORT_MAX_ROWS = 1000;
export const IMPORT_FIELDS = [
  'category',
  'name',
  'price',
  'taxRate',
  'description',
  'number',
] as const;
export const IMPORT_ROW_PROBLEMS = ['required', 'too_long', 'invalid', 'duplicate'] as const;

const raw = z.string().max(2000);

export const importProductRowSchema = z.strictObject({
  category: raw,
  name: raw,
  price: raw,
  taxRate: raw,
  description: raw.optional(),
  /** Menu number; empty or missing keeps the product's number (ADR 0029). */
  number: raw.optional(),
  /** The station of a category this row creates; existing categories keep theirs. */
  station: z.enum(PREP_STATIONS).optional(),
});

export const importProductsRequestSchema = z.strictObject({
  rows: z.array(importProductRowSchema).min(1).max(CATALOG_IMPORT_MAX_ROWS),
});

export const importRowProblemSchema = z.object({
  /** 1-based data row (the header is not counted). */
  row: z.int().min(1),
  field: z.enum(IMPORT_FIELDS),
  problem: z.enum(IMPORT_ROW_PROBLEMS),
});

export const importProductsResponseSchema = z.object({
  created: z.int(),
  updated: z.int(),
  unchanged: z.int(),
  categoriesCreated: z.int(),
  rows: z.array(
    z.object({
      row: z.int(),
      status: z.enum(['created', 'updated', 'unchanged']),
      productId: z.uuid(),
    }),
  ),
});

/** "Fill missing numbers" (ADR 0029). */
export const numberProductsResponseSchema = z.object({ numbered: z.int() });
export type NumberProductsResponse = z.infer<typeof numberProductsResponseSchema>;

/** Renumber the menu 1…N (ADR 0043): how many products got a different number. */
export const renumberProductsResponseSchema = z.object({ renumbered: z.int() });
export type RenumberProductsResponse = z.infer<typeof renumberProductsResponseSchema>;

export type ImportProductRow = z.infer<typeof importProductRowSchema>;
export type ImportProductsRequest = z.infer<typeof importProductsRequestSchema>;
export type ImportRowProblem = z.infer<typeof importRowProblemSchema>;
export type ImportProductsResponse = z.infer<typeof importProductsResponseSchema>;

/** The key two rows collide on: category + name, trimmed, case-insensitive. */
export function importRowKey(row: Pick<ImportProductRow, 'category' | 'name'>): string {
  return `${row.category.trim().toLowerCase()}\u0000${row.name.trim().toLowerCase()}`;
}

/** Every problem of every row (empty when the import may run). */
export function checkImportRows(rows: readonly ImportProductRow[]): ImportRowProblem[] {
  const problems: ImportRowProblem[] = [];
  const seen = new Set<string>();
  const numbers = new Set<string>();
  rows.forEach((r, index) => {
    const row = index + 1;
    const add = (field: ImportRowProblem['field'], problem: ImportRowProblem['problem']) =>
      problems.push({ row, field, problem });
    for (const field of ['category', 'name'] as const) {
      const value = r[field].trim();
      if (!value) add(field, 'required');
      else if (value.length > CATALOG_NAME_MAX_LENGTH) add(field, 'too_long');
    }
    if (!r.price.trim()) add('price', 'required');
    else if (!priceSchema.safeParse(r.price.trim()).success) add('price', 'invalid');
    if (!r.taxRate.trim()) add('taxRate', 'required');
    else if (!taxRateSchema.safeParse(r.taxRate.trim()).success) add('taxRate', 'invalid');
    if ((r.description ?? '').trim().length > PRODUCT_DESCRIPTION_MAX_LENGTH) {
      add('description', 'too_long');
    }
    const number = (r.number ?? '').trim();
    if (number) {
      if (!menuNumberSchema.safeParse(number).success) add('number', 'invalid');
      else if (numbers.has(number.toLowerCase())) add('number', 'duplicate');
      numbers.add(number.toLowerCase());
    }
    if (r.category.trim() && r.name.trim()) {
      const key = importRowKey(r);
      if (seen.has(key)) add('name', 'duplicate');
      seen.add(key);
    }
  });
  return problems;
}

/** Stable error codes of the catalog endpoints; the web app shows the matching label. */
export const CATALOG_ERROR_CODES = [
  'catalog.category_not_found',
  'catalog.product_not_found',
  'catalog.category_name_taken',
  'catalog.product_name_taken',
  'catalog.category_archived',
  'catalog.import_invalid',
  'catalog.price_invalid',
  'catalog.menu_number_taken',
  'catalog.price_rule_not_found',
  'catalog.price_rule_invalid',
  'catalog.location_not_found',
] as const;

export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];

/** `catalog.category_not_found` → `catalog.errors.categoryNotFound`. */
export function catalogErrorLabel(code: CatalogErrorCode): string {
  return `catalog.errors.${code.slice('catalog.'.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
