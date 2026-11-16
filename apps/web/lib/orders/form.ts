import {
  priceSchema,
  type SalesOrderStatus,
  type StockItem,
  stockQuantitySchema,
} from '@durby/shared';

/**
 * The order form and list in the browser (docs/modules/orders.md → Web, ADR 0044). Totals are previews in exact
 * cents (BigInt, CLAUDE.md rule 6); the api computes the stored ones the same way.
 */

export interface DraftLine {
  itemId: string;
  quantity: string;
  unitPrice: string;
}

/** "1.5" → 1500n (thousandths); anything that isn't a quantity → null. */
function thousandths(value: string): bigint | null {
  const match = /^(\d{1,10})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  return BigInt(`${match[1]}${(match[2] ?? '').padEnd(3, '0')}`);
}

/** "12.9" → 1290n; anything that isn't a price → null. */
function cents(value: string): bigint | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return BigInt(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`);
}

const text = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;

/** quantity × price rounded half up to cents, as the api does; null while either is invalid. */
export function lineTotal(quantity: string, unitPrice: string): string | null {
  const q = thousandths(quantity);
  const p = cents(unitPrice);
  if (q === null || p === null) return null;
  // q/1000 × p/100 = q·p/100000 units = q·p/1000 cents.
  return text((q * p + 500n) / 1000n);
}

/** The sum of the valid lines' totals. */
export function draftTotal(lines: readonly DraftLine[]): string {
  let sum = 0n;
  for (const line of lines) {
    const total = lineTotal(line.quantity, line.unitPrice);
    if (total !== null) sum += cents(total) ?? 0n;
  }
  return text(sum);
}

/** Whether every line has a positive quantity (3 decimals) and a price (2 decimals), as the api checks. */
export function linesValid(lines: readonly DraftLine[]): boolean {
  return lines.every(
    (l) =>
      stockQuantitySchema.safeParse(l.quantity.trim()).success &&
      priceSchema.safeParse(l.unitPrice.trim()).success,
  );
}

/** Items an order can sell: active, and not a parent whose variants hold the stock (ADR 0038). */
export function sellableItems(items: readonly StockItem[]): StockItem[] {
  const parents = new Set(
    items
      .filter((i) => i.parentItemId !== null && i.archivedAt === null)
      .map((i) => i.parentItemId),
  );
  return items
    .filter((i) => i.archivedAt === null && !parents.has(i.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A variant's display name: "T-shirt · Large / Red". */
export function itemLabel(item: StockItem, items: readonly StockItem[]): string {
  if (item.parentItemId === null || item.variantValues.length === 0) return item.name;
  const parent = items.find((i) => i.id === item.parentItemId);
  return `${parent?.name ?? item.name} · ${item.variantValues.join(' / ')}`;
}

/** Badge tone per status: drafts stand out, delivered looks done, cancelled recedes. */
export function statusTone(status: SalesOrderStatus): 'draft' | 'open' | 'done' | 'cancelled' {
  if (status === 'delivered') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'draft') return 'draft';
  return 'open';
}

/** The from/to instants of a day range in the browser's time zone: `to` is the start of the day after. */
export function dayRange(from: string, to: string): { from?: string; to?: string } {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const start = (value: string) => new Date(`${value}T00:00:00`);
  const out: { from?: string; to?: string } = {};
  if (day.test(from)) out.from = start(from).toISOString();
  if (day.test(to)) {
    const end = start(to);
    end.setDate(end.getDate() + 1);
    out.to = end.toISOString();
  }
  return out;
}

/** Loaded orders matching a search: number or customer, ignoring case. */
export function matchesOrder(
  order: { number: string; customerName: string },
  search: string,
): boolean {
  const q = search.trim().toLowerCase();
  return (
    q === '' ||
    order.number.toLowerCase().includes(q) ||
    order.customerName.toLowerCase().includes(q)
  );
}

/** Exact comparison of two quantities (3 decimals): negative, 0 or positive; null if either isn't one. */
export function compareQuantity(a: string, b: string): number | null {
  const x = thousandths(a);
  const y = thousandths(b);
  if (x === null || y === null) return null;
  return x === y ? 0 : x < y ? -1 : 1;
}
