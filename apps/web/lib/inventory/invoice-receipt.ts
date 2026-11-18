import {
  INVENTORY_NAME_MAX_LENGTH,
  type StockItem,
  stockQuantitySchema,
  type StockUnit,
  type SubmitVendorInvoiceRequest,
  unitCostSchema,
  type VendorInvoice,
  type VendorInvoiceSource,
} from '@durby/shared';
import type { InvoiceLine, ParsedInvoice } from './invoice-pdf';
import { EMPTY_PACK, type PackSize, packFields, packProblems, parsePackSize } from './pack-size';

/**
 * The review of a vendor invoice before it becomes a goods receipt (ADR 0049): each line matched to a stock item or
 * marked new, with quantity and unit cost the person may change. Pure: the page renders and edits these rows.
 */

export const NEW_ITEM = 'new';

export interface InvoiceRow {
  line: InvoiceLine;
  include: boolean;
  /** A stock item's id, or NEW_ITEM. */
  target: string;
  /** In `unitId` when one is chosen, else in the item's unit. */
  quantity: string;
  unitCost: string;
  /** The unit the supplier invoices in (ADR 0055): a unit of measurement's id, or '' for the item's own unit. */
  unitId: string;
  /** For a new item (ADR 0055): its unit, category ('' none), brand and pack size. */
  newUnit: StockUnit;
  categoryId: string;
  brand: string;
  pack: PackSize;
}

export type RowProblem = 'quantity' | 'unitCost' | 'duplicate' | 'newNotAllowed' | 'pack';

const normal = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Up to 3 decimals for a quantity, 4 for a cost, as the api takes them: "50.00" stays, "1.23456" is refused. */
const clean = (value: string) => value.trim().replace(',', '.');

/**
 * Rows from the invoice lines: matched by SKU = the supplier's product id first, then by the exact name (case and
 * spacing aside), among active items that hold stock (not parents with variants); else new.
 */
export function matchInvoice(
  lines: readonly InvoiceLine[],
  items: readonly StockItem[],
  newUnit: StockUnit = 'pc',
): InvoiceRow[] {
  const parents = new Set(
    items.map((i) => i.parentItemId).filter((id): id is string => id !== null),
  );
  const usable = items.filter((i) => i.archivedAt === null && !parents.has(i.id));
  const bySku = new Map(usable.filter((i) => i.sku).map((i) => [normal(i.sku!), i.id]));
  const byName = new Map(usable.map((i) => [normal(i.name), i.id]));
  const byId = new Map(items.map((i) => [i.id, i]));
  return lines.map((line) => {
    const target =
      (line.code ? bySku.get(normal(line.code)) : undefined) ??
      byName.get(normal(line.description)) ??
      NEW_ITEM;
    return {
      line,
      include: true,
      target,
      quantity: line.quantity,
      unitCost: line.unitPrice,
      unitId: '',
      newUnit,
      ...detailsFor(line, byId.get(target)),
    };
  });
}

/**
 * A row's category, brand and pack size (ADR 0055): the matched item's own, its missing pack size read from the
 * description ("5 x 2kg"); for a new item none but that pack size.
 */
export function detailsFor(
  line: InvoiceLine,
  item: StockItem | undefined,
): Pick<InvoiceRow, 'categoryId' | 'brand' | 'pack'> {
  const read = parsePackSize(line.description) ?? EMPTY_PACK;
  if (!item) return { categoryId: '', brand: '', pack: read };
  const own = itemPack(item);
  return {
    categoryId: item.categoryId ?? '',
    brand: item.brand ?? '',
    pack: own.count === '' && own.size === '' ? read : own,
  };
}

/** An item's pack size as typed text. */
const itemPack = (item: StockItem): PackSize => ({
  count: item.packCount === null ? '' : String(item.packCount),
  size: item.packSize?.replace(/\.?0+$/, '') ?? '',
  unit: item.packUnit ?? '',
});

/** Another item (or New) for a row: its details follow the item (ADR 0055). */
export function retarget(row: InvoiceRow, target: string, items: readonly StockItem[]): InvoiceRow {
  const item = target === NEW_ITEM ? undefined : items.find((i) => i.id === target);
  return { ...row, target, unitId: '', ...detailsFor(row.line, item) };
}

/**
 * What an existing item's row changes on it (ADR 0055): category, brand and pack size where they differ from the
 * item's; undefined when nothing does. A category is set, never cleared, from an invoice.
 */
export function itemDetailsChange(row: InvoiceRow, item: StockItem | undefined) {
  if (!item) return undefined;
  const own = itemPack(item);
  const pack = packFields(row.pack);
  const sameSize =
    (row.pack.size.trim() === '' && own.size === '') ||
    (pack.packSize !== undefined &&
      own.size !== '' &&
      Number(pack.packSize) === Number(own.size) &&
      pack.packUnit === own.unit);
  const change = {
    ...(row.categoryId && row.categoryId !== (item.categoryId ?? '')
      ? { categoryId: row.categoryId }
      : {}),
    ...(row.brand.trim() && row.brand.trim() !== (item.brand ?? '')
      ? { brand: row.brand.trim().slice(0, 100) }
      : {}),
    ...(pack.packCount !== undefined && String(pack.packCount) !== own.count
      ? { packCount: pack.packCount }
      : {}),
    ...(!sameSize && pack.packSize !== undefined
      ? { packSize: pack.packSize, packUnit: pack.packUnit }
      : {}),
  };
  return Object.keys(change).length > 0 ? change : undefined;
}

/** Gives every row without a category this one, new or existing item (the "set for all without one" action). */
export function setMissingCategory(rows: readonly InvoiceRow[], categoryId: string): InvoiceRow[] {
  return rows.map((r) => (r.include && r.categoryId === '' ? { ...r, categoryId } : r));
}

/** Included rows still without a category. */
export const missingCategory = (rows: readonly InvoiceRow[]) =>
  rows.filter((r) => r.include && r.categoryId === '').length;

/** What keeps each included row from importing (empty: it can go). */
export function rowProblems(rows: readonly InvoiceRow[], canCreate: boolean): RowProblem[][] {
  // An item twice, or two new items of the same name: the api takes each once.
  const keyOf = (row: InvoiceRow) =>
    row.target === NEW_ITEM ? `new:${normal(newItemName(row.line))}` : row.target;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.include) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  }
  return rows.map((row) => {
    if (!row.include) return [];
    const problems: RowProblem[] = [];
    const quantity = clean(row.quantity);
    if (!stockQuantitySchema.safeParse(quantity).success || Number(quantity) === 0) {
      problems.push('quantity');
    }
    if (!unitCostSchema.safeParse(clean(row.unitCost)).success) problems.push('unitCost');
    if ((counts.get(keyOf(row)) ?? 0) > 1) problems.push('duplicate');
    if (row.target === NEW_ITEM && !canCreate) problems.push('newNotAllowed');
    if (packProblems(row.pack).length > 0) problems.push('pack');
    return problems;
  });
}

/** The new item a row creates: the invoice's description as its name, the supplier's product id as its SKU. */
export function newItemName(line: InvoiceLine): string {
  return line.description.trim().slice(0, INVENTORY_NAME_MAX_LENGTH);
}

/** The invoice to submit for approval (ADR 0054): the included rows; call only when rowProblems finds none. */
export function submitRequest(input: {
  /** To send only what changes on existing items (ADR 0055). */
  items?: readonly StockItem[];
  rows: readonly InvoiceRow[];
  warehouseId: string;
  supplier: string;
  note: string;
  invoice: Pick<ParsedInvoice, 'number' | 'date' | 'total'>;
  fileName: string | null;
  source: VendorInvoiceSource;
}): SubmitVendorInvoiceRequest {
  return {
    warehouseId: input.warehouseId,
    ...(input.supplier.trim()
      ? { supplier: input.supplier.trim().slice(0, INVENTORY_NAME_MAX_LENGTH) }
      : {}),
    ...(input.invoice.number ? { invoiceNumber: input.invoice.number.slice(0, 50) } : {}),
    ...(input.invoice.date ? { invoiceDate: input.invoice.date.slice(0, 20) } : {}),
    ...(input.note.trim() ? { note: input.note.trim().slice(0, 500) } : {}),
    ...(input.invoice.total && /^\d{1,10}(\.\d{1,2})?$/.test(input.invoice.total)
      ? { printedTotal: input.invoice.total }
      : {}),
    ...(input.fileName ? { fileName: input.fileName.slice(0, 200) } : {}),
    source: input.source,
    lines: input.rows
      .filter((r) => r.include)
      .map((r) => {
        const base = {
          ...(r.line.code ? { code: r.line.code.slice(0, 50) } : {}),
          description: r.line.description.slice(0, 300),
          quantity: clean(r.quantity),
          unitCost: clean(r.unitCost),
          ...(r.unitId ? { unitId: r.unitId } : {}),
        };
        if (r.target !== NEW_ITEM) {
          const itemDetails = itemDetailsChange(
            r,
            input.items?.find((i) => i.id === r.target),
          );
          return { ...base, itemId: r.target, ...(itemDetails ? { itemDetails } : {}) };
        }
        return {
          ...base,
          newItem: {
            name: newItemName(r.line),
            ...(r.line.code ? { sku: r.line.code.slice(0, 50) } : {}),
            unit: r.newUnit,
            ...(r.categoryId ? { categoryId: r.categoryId } : {}),
            ...(r.brand.trim() ? { brand: r.brand.trim().slice(0, 100) } : {}),
            ...packFields(r.pack),
          },
        };
      }),
  };
}

/** A stored invoice back as review rows (the approver's edit): every line included, as saved. */
export function rowsFromInvoice(
  invoice: VendorInvoice,
  items: readonly StockItem[] = [],
): InvoiceRow[] {
  return invoice.lines.map((l) => {
    const line = {
      code: l.code,
      description: l.newItem?.name ?? l.description,
      quantity: l.quantity,
      unitPrice: l.unitCost,
      vatRate: null,
      total: l.value,
      checks: true,
    };
    // A new item's details as proposed; an existing item's own, with what the line changes on top (ADR 0055).
    const item = l.itemId ? items.find((i) => i.id === l.itemId) : undefined;
    const base = detailsFor(line, item);
    const given = l.newItem ?? l.itemDetails;
    return {
      line,
      include: true,
      target: l.itemId ?? NEW_ITEM,
      unitId: l.unitId ?? '',
      newUnit: l.newItem?.unit ?? 'pc',
      categoryId: given?.categoryId ?? (l.newItem ? '' : base.categoryId),
      brand: given?.brand ?? (l.newItem ? '' : base.brand),
      pack:
        given && (given.packCount !== null || given.packSize !== null)
          ? {
              count: given.packCount === null ? '' : String(given.packCount),
              size: given.packSize?.replace(/\.?0+$/, '') ?? '',
              unit: given.packUnit ?? '',
            }
          : l.newItem
            ? EMPTY_PACK
            : base.pack,
      // "50.000" → "50", "41.5000" → "41.50", "0.4150" → "0.415": as a person types them.
      quantity: l.quantity.includes('.')
        ? l.quantity.replace(/0+$/, '').replace(/\.$/, '')
        : l.quantity,
      unitCost: l.unitCost.replace(/(\.\d\d\d*?)0+$/, '$1'),
    };
  });
}
