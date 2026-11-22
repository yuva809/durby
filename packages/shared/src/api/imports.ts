import { z } from 'zod';
import { CATALOG_NAME_MAX_LENGTH, priceSchema } from './catalog';
import {
  BRAND_MAX_LENGTH,
  INVENTORY_NAME_MAX_LENGTH,
  STOCK_UNITS,
  stockQuantitySchema,
  unitCostSchema,
} from './inventory';
import {
  ORDER_CUSTOMER_CODE_MAX_LENGTH,
  ORDER_CUSTOMER_NAME_MAX_LENGTH,
  ORDER_TEXT_MAX_LENGTH,
} from './orders';
import { packFields, packProblems, parsePackCell, type UnitLabels, unitLookup } from '../pack-size';

/**
 * Import Data (docs/platform/import.md, ADR 0044 step 4): CSV files read in the browser, rows sent as JSON to the
 * owning module, which checks them again and writes them in one transaction (all or nothing). The checks here run in
 * both places, so the preview shows the same problems the api would refuse.
 */

export const IMPORT_MAX_ROWS = 5000;

export const IMPORT_KINDS = ['categories', 'items', 'opening_stock', 'customers'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const DATA_IMPORT_PROBLEMS = [
  'required',
  'too_long',
  'invalid',
  'duplicate',
  'unknown',
  /** A bare category name used by several categories: say "Parent / Child". */
  'ambiguous',
] as const;
export type DataImportProblem = (typeof DATA_IMPORT_PROBLEMS)[number];

/** Optional text cells: empty means "not given". */
const cell = z.string().max(10_000);

export const categoryImportRowSchema = z.strictObject({ name: cell });
export const itemImportRowSchema = z.strictObject({
  name: cell,
  sku: cell.optional(),
  unit: cell,
  brand: cell.optional(),
  /** "12 x 500 ml", "5kg", "10", "Pack of 6" (ADR 0055). */
  packSize: cell.optional(),
  /** An existing category by name, or "Parent / Child" (ADR 0048). Never created by the import. */
  category: cell.optional(),
  minQuantity: cell.optional(),
  salePrice: cell.optional(),
});
export const openingStockImportRowSchema = z.strictObject({
  warehouse: cell,
  /** The item's SKU, else its name. */
  item: cell,
  quantity: cell,
  unitCost: cell,
});
export const customerImportRowSchema = z.strictObject({
  name: cell,
  code: cell.optional(),
  phone: cell.optional(),
  email: cell.optional(),
  address: cell.optional(),
  note: cell.optional(),
});

const rows = <T extends z.ZodType>(row: T) =>
  z.strictObject({ rows: z.array(row).min(1).max(IMPORT_MAX_ROWS) });

export const importCategoriesRequestSchema = rows(categoryImportRowSchema);
export const importItemsRequestSchema = rows(itemImportRowSchema);
export const importOpeningStockRequestSchema = rows(openingStockImportRowSchema);
export const importCustomersRequestSchema = rows(customerImportRowSchema);

export const dataImportResultSchema = z.object({
  created: z.int(),
  updated: z.int(),
  unchanged: z.int(),
  /** Stock documents written (opening stock: one receipt per warehouse). */
  documents: z.array(z.string()).default([]),
});

export const dataImportProblemSchema = z.object({
  /** 1-based data row (the header is not counted). */
  row: z.int().min(1),
  field: z.string(),
  problem: z.enum(DATA_IMPORT_PROBLEMS),
});

export type CategoryImportRow = z.infer<typeof categoryImportRowSchema>;
export type ItemImportRow = z.infer<typeof itemImportRowSchema>;
export type OpeningStockImportRow = z.infer<typeof openingStockImportRowSchema>;
export type CustomerImportRow = z.infer<typeof customerImportRowSchema>;
export type ImportCategoriesRequest = z.infer<typeof importCategoriesRequestSchema>;
export type ImportItemsRequest = z.infer<typeof importItemsRequestSchema>;
export type ImportOpeningStockRequest = z.infer<typeof importOpeningStockRequestSchema>;
export type ImportCustomersRequest = z.infer<typeof importCustomersRequestSchema>;
export type DataImportResult = z.infer<typeof dataImportResultSchema>;
export type DataImportProblemRow = z.infer<typeof dataImportProblemSchema>;

/** The CSV header of each kind's template: also the canonical column names. */
export const IMPORT_TEMPLATES: Readonly<Record<ImportKind, readonly string[]>> = {
  categories: ['name'],
  items: ['name', 'sku', 'unit', 'brand', 'pack_size', 'category', 'min_quantity', 'sale_price'],
  opening_stock: ['warehouse', 'item', 'quantity', 'unit_cost'],
  customers: ['name', 'code', 'phone', 'email', 'address', 'note'],
};

/** Which template columns must be in the file. */
export const IMPORT_REQUIRED_COLUMNS: Readonly<Record<ImportKind, readonly string[]>> = {
  categories: ['name'],
  items: ['name', 'unit'],
  opening_stock: ['warehouse', 'item', 'quantity', 'unit_cost'],
  customers: ['name'],
};

const key = (value: string) => value.trim().toLowerCase();

class Problems {
  readonly list: DataImportProblemRow[] = [];
  add(row: number, field: string, problem: DataImportProblem) {
    this.list.push({ row, field, problem });
  }
  text(row: number, field: string, value: string | undefined, max: number, required: boolean) {
    const v = (value ?? '').trim();
    if (!v) {
      if (required) this.add(row, field, 'required');
    } else if (v.length > max) this.add(row, field, 'too_long');
    return v;
  }
  /** Each value once (case-insensitive); empty values never collide. */
  unique(seen: Set<string>, row: number, field: string, value: string) {
    if (!value) return;
    if (seen.has(key(value))) this.add(row, field, 'duplicate');
    else seen.add(key(value));
  }
}

export function checkCategoryRows(input: readonly CategoryImportRow[]): DataImportProblemRow[] {
  const p = new Problems();
  const names = new Set<string>();
  input.forEach((r, i) => {
    const name = p.text(i + 1, 'name', r.name, CATALOG_NAME_MAX_LENGTH, true);
    p.unique(names, i + 1, 'name', name);
  });
  return p.list;
}

/**
 * The pack size an item row's cell gives (ADR 0055), or null when the cell is empty or no valid pack size.
 * `labelOf` is the shown name of each unit (the organization's labels); without it only codes are known.
 */
export function itemRowPack(
  cell: string | undefined,
  labelOf: UnitLabels = (unit) => unit,
): ReturnType<typeof packFields> | null {
  const text = (cell ?? '').trim();
  if (!text) return null;
  const pack = parsePackCell(text, unitLookup(labelOf));
  return pack && packProblems(pack).length === 0 ? packFields(pack) : null;
}

/** A category as the import sees it: the organization's non-archived ones, children pointing at their parent. */
export interface ImportCategory {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * The category a cell names (ADR 0048): the whole text as a name first (so "Oil / Ghee" may be a name), else a path
 * "Parent / Child". Case and spaces around names are ignored. `ambiguous`: a bare name several categories have.
 */
export function resolveCategory(
  text: string,
  categories: readonly ImportCategory[],
): { id: string } | 'unknown' | 'ambiguous' {
  const cell = text.trim();
  const byName = (name: string) => categories.filter((c) => key(c.name) === key(name));
  const answer = (ids: readonly string[]) =>
    ids.length === 1
      ? { id: ids[0]! }
      : ids.length === 0
        ? ('unknown' as const)
        : ('ambiguous' as const);
  const named = byName(cell);
  if (named.length > 0) return answer(named.map((c) => c.id));
  const ids = new Set<string>();
  for (let i = cell.indexOf('/'); i !== -1; i = cell.indexOf('/', i + 1)) {
    const parents = byName(cell.slice(0, i)).filter((c) => c.parentId === null);
    for (const child of byName(cell.slice(i + 1))) {
      if (child.parentId && parents.some((p) => p.id === child.parentId)) ids.add(child.id);
    }
  }
  return answer([...ids]);
}

export function checkItemRows(
  input: readonly ItemImportRow[],
  labelOf?: UnitLabels,
  /** The categories to check the `category` cells against; without them the cells are not judged. */
  known?: { categories: readonly ImportCategory[] },
): DataImportProblemRow[] {
  const p = new Problems();
  const names = new Set<string>();
  const skus = new Set<string>();
  input.forEach((r, i) => {
    const row = i + 1;
    const name = p.text(row, 'name', r.name, INVENTORY_NAME_MAX_LENGTH, true);
    const sku = p.text(row, 'sku', r.sku, 50, false);
    // Rows meet existing items by SKU when they have one, else by name.
    if (sku) p.unique(skus, row, 'sku', sku);
    else p.unique(names, row, 'name', name);
    p.text(row, 'brand', r.brand, BRAND_MAX_LENGTH, false);
    if ((r.packSize ?? '').trim() && !itemRowPack(r.packSize, labelOf)) {
      p.add(row, 'packSize', 'invalid');
    }
    const category = (r.category ?? '').trim();
    if (category && known) {
      const found = resolveCategory(category, known.categories);
      if (found === 'unknown' || found === 'ambiguous') p.add(row, 'category', found);
    }
    const unit = key(r.unit);
    if (!unit) p.add(row, 'unit', 'required');
    else if (!(STOCK_UNITS as readonly string[]).includes(unit)) p.add(row, 'unit', 'invalid');
    const min = (r.minQuantity ?? '').trim();
    if (min && !stockQuantitySchema.safeParse(min).success) p.add(row, 'minQuantity', 'invalid');
    const price = (r.salePrice ?? '').trim();
    if (price && !priceSchema.safeParse(price).success) p.add(row, 'salePrice', 'invalid');
  });
  return p.list;
}

/**
 * Opening stock rows. `known` (the warehouses' and items' names and SKUs, lower case) also checks the references;
 * the api passes its own, the browser what it loaded.
 */
export function checkOpeningStockRows(
  input: readonly OpeningStockImportRow[],
  known?: { warehouses: ReadonlySet<string>; items: ReadonlySet<string> },
): DataImportProblemRow[] {
  const p = new Problems();
  const pairs = new Set<string>();
  input.forEach((r, i) => {
    const row = i + 1;
    const warehouse = p.text(row, 'warehouse', r.warehouse, INVENTORY_NAME_MAX_LENGTH, true);
    const item = p.text(row, 'item', r.item, INVENTORY_NAME_MAX_LENGTH, true);
    if (known && warehouse && !known.warehouses.has(key(warehouse))) {
      p.add(row, 'warehouse', 'unknown');
    }
    if (known && item && !known.items.has(key(item))) p.add(row, 'item', 'unknown');
    if (warehouse && item) p.unique(pairs, row, 'item', `${warehouse}\u0000${item}`);
    const quantity = r.quantity.trim();
    if (!quantity) p.add(row, 'quantity', 'required');
    else if (!stockQuantitySchema.safeParse(quantity).success) p.add(row, 'quantity', 'invalid');
    const cost = r.unitCost.trim();
    if (!cost) p.add(row, 'unitCost', 'required');
    else if (!unitCostSchema.safeParse(cost).success) p.add(row, 'unitCost', 'invalid');
  });
  return p.list;
}

const email = z.email();

export function checkCustomerRows(input: readonly CustomerImportRow[]): DataImportProblemRow[] {
  const p = new Problems();
  const names = new Set<string>();
  const codes = new Set<string>();
  input.forEach((r, i) => {
    const row = i + 1;
    const name = p.text(row, 'name', r.name, ORDER_CUSTOMER_NAME_MAX_LENGTH, true);
    const code = p.text(row, 'code', r.code, ORDER_CUSTOMER_CODE_MAX_LENGTH, false);
    // Rows meet existing customers by code when they have one, else by name.
    if (code) p.unique(codes, row, 'code', code);
    else p.unique(names, row, 'name', name);
    p.text(row, 'phone', r.phone, 40, false);
    const mail = p.text(row, 'email', r.email, 254, false);
    if (mail && !email.safeParse(mail).success) p.add(row, 'email', 'invalid');
    p.text(row, 'address', r.address, ORDER_TEXT_MAX_LENGTH, false);
    p.text(row, 'note', r.note, ORDER_TEXT_MAX_LENGTH, false);
  });
  return p.list;
}

/** Stable error codes of the import endpoints (one per owning module). */
export const DATA_IMPORT_ERROR_CODES = [
  'inventory.import_invalid',
  'orders.import_invalid',
] as const;
export type DataImportErrorCode = (typeof DATA_IMPORT_ERROR_CODES)[number];
