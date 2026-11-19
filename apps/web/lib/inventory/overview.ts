import type { ProductCategory, StockItem, StockLevel } from '@durby/shared';

/**
 * The inventory overview of the operations menu (docs/modules/inventory.md → Overview, ADR 0048): stock items with
 * their stock, grouped by category for the tiles. Pure functions; the page renders them.
 */

/** Which items the page lists: all, the uncategorized ones, or a category (with its secondary categories). */
export type CategorySelection =
  { kind: 'all' } | { kind: 'none' } | { kind: 'category'; id: string };

export type StockState = 'all' | 'low' | 'out';

export interface ItemRow {
  item: StockItem;
  /** Over the warehouses shown, 3 decimals. */
  quantity: string;
  /** Over the warehouses shown, 2 decimals. */
  value: string | null;
  /** At or below the reorder level in any warehouse shown. */
  low: boolean;
}

/** Exact decimal sums: amounts are strings (CLAUDE.md rule 6), counted in thousandths. */
function toThousandths(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const n = BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3));
  return negative ? -n : n;
}

function fromThousandths(n: bigint, decimals: 2 | 3): string {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / 1000n;
  const fraction = (abs % 1000n).toString().padStart(3, '0').slice(0, decimals);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function sumDecimals(values: readonly string[], decimals: 2 | 3): string {
  return fromThousandths(
    values.reduce((sum, v) => sum + toThousandths(v), 0n),
    decimals,
  );
}

/**
 * One row per active stock item that holds stock (not a parent with variants: those hold none), with its stock in
 * the levels given (already filtered to a warehouse, or all). An item without a level has 0.
 */
export function itemRows(items: readonly StockItem[], levels: readonly StockLevel[]): ItemRow[] {
  const parents = new Set(
    items.map((i) => i.parentItemId).filter((id): id is string => id !== null),
  );
  const byItem = new Map<string, StockLevel[]>();
  for (const level of levels) {
    byItem.set(level.itemId, [...(byItem.get(level.itemId) ?? []), level]);
  }
  return items
    .filter((item) => item.archivedAt === null && !parents.has(item.id))
    .map((item) => {
      const own = byItem.get(item.id) ?? [];
      return {
        item,
        quantity: sumDecimals(
          own.map((l) => l.quantity),
          3,
        ),
        // Null when the api left values out (no inventory.prices.read, ADR 0060).
        value: own.every((l) => l.value !== null)
          ? sumDecimals(
              own.map((l) => l.value ?? '0'),
              2,
            )
          : null,
        low: own.some((l) => l.low),
      };
    });
}

export function inStockState(row: ItemRow, state: StockState): boolean {
  if (state === 'low') return row.low;
  if (state === 'out') return toThousandths(row.quantity) <= 0n;
  return true;
}

/** The category a row counts under on the tiles: its top-level category (a secondary one counts for its parent). */
function topLevelOf(
  categoryId: string | null,
  byId: ReadonlyMap<string, ProductCategory>,
): string | null {
  if (categoryId === null) return null;
  const category = byId.get(categoryId);
  if (!category) return null;
  return category.parentId && byId.has(category.parentId) ? category.parentId : category.id;
}

export function inSelection(
  row: ItemRow,
  selection: CategorySelection,
  categories: readonly ProductCategory[],
): boolean {
  if (selection.kind === 'all') return true;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const known = row.item.categoryId !== null && byId.has(row.item.categoryId);
  if (selection.kind === 'none') return !known;
  return (
    row.item.categoryId === selection.id || topLevelOf(row.item.categoryId, byId) === selection.id
  );
}

export interface CategoryTile {
  selection: CategorySelection;
  category: ProductCategory | null;
  count: number;
}

/**
 * The tiles: All items, then each active top-level category in menu order with the rows under it (its secondary
 * categories included), then Uncategorized when some rows have no (known) category. Empty categories show with 0.
 */
export function categoryTiles(
  rows: readonly ItemRow[],
  categories: readonly ProductCategory[],
): CategoryTile[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    const top = topLevelOf(row.item.categoryId, byId);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const topLevel = categories
    .filter((c) => c.archivedAt === null && c.parentId === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const uncategorized = counts.get(null) ?? 0;
  return [
    { selection: { kind: 'all' }, category: null, count: rows.length },
    ...topLevel.map((category) => ({
      selection: { kind: 'category' as const, id: category.id },
      category,
      count: counts.get(category.id) ?? 0,
    })),
    ...(uncategorized > 0
      ? [{ selection: { kind: 'none' as const }, category: null, count: uncategorized }]
      : []),
  ];
}

/** Active secondary categories of `id`, in menu order. */
export function secondaryCategories(
  categories: readonly ProductCategory[],
  id: string,
): ProductCategory[] {
  return categories
    .filter((c) => c.parentId === id && c.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** "Food › Rice" for a secondary category, else its name; "" without one. */
export function categoryPath(categories: readonly ProductCategory[], id: string | null): string {
  if (!id) return '';
  const category = categories.find((c) => c.id === id);
  if (!category) return '';
  const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : null;
  return parent ? `${parent.name} › ${category.name}` : category.name;
}

const BOM = String.fromCharCode(0xfeff);

/** RFC 4180 CSV with a UTF-8 byte order mark, so Excel opens umlauts and € correctly. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (value: string) =>
    /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return `${BOM}${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
