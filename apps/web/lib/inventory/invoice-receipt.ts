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

/** The invoice to submit for approval (ADR 0051): the included rows; call only when rowProblems finds none. */
export function submitRequest(input: {
  rows: readonly InvoiceRow[];
  warehouseId: string;
  supplier: string;
  note: string;
  invoice: Pick<ParsedInvoice, 'number' | 'date' | 'total'>;
  fileName: string | null;
  source: VendorInvoiceSource;
  newItemUnit: StockUnit;
  newItemCategoryId: string | null;
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
        };
        if (r.target !== NEW_ITEM) return { ...base, itemId: r.target };
        return {
          ...base,
          newItem: {
            name: newItemName(r.line),
            ...(r.line.code ? { sku: r.line.code.slice(0, 50) } : {}),
            unit: input.newItemUnit,
            ...(input.newItemCategoryId ? { categoryId: input.newItemCategoryId } : {}),
          },
        };
      }),
  };
}

/** A stored invoice back as review rows (the approver's edit): every line included, as saved. */
export function rowsFromInvoice(invoice: VendorInvoice): InvoiceRow[] {
  return invoice.lines.map((l) => ({
    line: {
      code: l.code,
      description: l.newItem?.name ?? l.description,
      quantity: l.quantity,
      unitPrice: l.unitCost,
      vatRate: null,
      total: l.value,
      checks: true,
    },
    include: true,
    target: l.itemId ?? NEW_ITEM,
    // "50.000" → "50", "41.5000" → "41.50", "0.4150" → "0.415": as a person types them.
    quantity: l.quantity.includes('.')
      ? l.quantity.replace(/0+$/, '').replace(/\.$/, '')
      : l.quantity,
    unitCost: l.unitCost.replace(/(\.\d\d\d*?)0+$/, '$1'),
  }));
}
