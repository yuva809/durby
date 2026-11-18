import {
  type ImportReceiptRequest,
  INVENTORY_NAME_MAX_LENGTH,
  type StockItem,
  stockQuantitySchema,
  type StockUnit,
  unitCostSchema,
} from '@durby/shared';
import type { InvoiceLine } from './invoice-pdf';

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
  quantity: string;
  unitCost: string;
}

export type RowProblem = 'quantity' | 'unitCost' | 'duplicate' | 'newNotAllowed';

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
): InvoiceRow[] {
  const parents = new Set(
    items.map((i) => i.parentItemId).filter((id): id is string => id !== null),
  );
  const usable = items.filter((i) => i.archivedAt === null && !parents.has(i.id));
  const bySku = new Map(usable.filter((i) => i.sku).map((i) => [normal(i.sku!), i.id]));
  const byName = new Map(usable.map((i) => [normal(i.name), i.id]));
  return lines.map((line) => ({
    line,
    include: true,
    target:
      (line.code ? bySku.get(normal(line.code)) : undefined) ??
      byName.get(normal(line.description)) ??
      NEW_ITEM,
    quantity: line.quantity,
    unitCost: line.unitPrice,
  }));
}

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
    return problems;
  });
}

/** The new item a row creates: the invoice's description as its name, the supplier's product id as its SKU. */
export function newItemName(line: InvoiceLine): string {
  return line.description.trim().slice(0, INVENTORY_NAME_MAX_LENGTH);
}

/** The request for the included rows; call only when rowProblems finds none. */
export function receiptRequest(input: {
  rows: readonly InvoiceRow[];
  warehouseId: string;
  supplier: string;
  note: string;
  newItemUnit: StockUnit;
  newItemCategoryId: string | null;
}): ImportReceiptRequest {
  return {
    warehouseId: input.warehouseId,
    ...(input.supplier.trim() ? { supplier: input.supplier.trim() } : {}),
    ...(input.note.trim() ? { note: input.note.trim() } : {}),
    lines: input.rows
      .filter((r) => r.include)
      .map((r) => {
        const amounts = { quantity: clean(r.quantity), unitCost: clean(r.unitCost) };
        if (r.target !== NEW_ITEM) return { itemId: r.target, ...amounts };
        return {
          newItem: {
            name: newItemName(r.line),
            ...(r.line.code ? { sku: r.line.code.slice(0, 50) } : {}),
            unit: input.newItemUnit,
            ...(input.newItemCategoryId ? { categoryId: input.newItemCategoryId } : {}),
          },
          ...amounts,
        };
      }),
  };
}
