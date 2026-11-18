import type { ProductCategory, StockItem, StockLevel } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  categoryPath,
  categoryTiles,
  inSelection,
  inStockState,
  itemRows,
  secondaryCategories,
  sumDecimals,
  toCsv,
} from './overview';

const id = (n: number) => `0190a000-0000-7000-8000-0000000048${String(n).padStart(2, '0')}`;
const category = (
  n: number,
  name: string,
  parentId: string | null = null,
  archived = false,
): ProductCategory => ({
  id: id(n),
  name,
  sortOrder: n * 10,
  station: 'kitchen',
  description: null,
  parentId,
  imageVersion: null,
  archivedAt: archived ? '2026-11-01T00:00:00.000Z' : null,
});
const FOOD = category(1, 'Food');
const RICE = category(2, 'Rice', FOOD.id);
const DRINKS = category(3, 'Drinks');
const OLD = category(4, 'Old', null, true);
const CATEGORIES = [DRINKS, RICE, FOOD, OLD];

const item = (n: number, name: string, categoryId: string | null, extra: Partial<StockItem> = {}) =>
  ({
    id: id(20 + n),
    name,
    sku: null,
    unit: 'pc',
    minQuantity: null,
    parentItemId: null,
    variantValues: [],
    salePrice: null,
    categoryId,
    archivedAt: null,
    ...extra,
  }) satisfies StockItem;
const BASMATI = item(1, 'Basmati', RICE.id);
const FLOUR = item(2, 'Flour', FOOD.id);
const COLA = item(3, 'Cola', DRINKS.id);
const LOOSE = item(4, 'Loose', null);
const GONE = item(5, 'Gone', FOOD.id, { archivedAt: '2026-11-01T00:00:00.000Z' });
const SHIRT = item(6, 'Shirt', null);
const SHIRT_S = item(7, 'Shirt S', DRINKS.id, { parentItemId: SHIRT.id });

const level = (itemId: string, warehouseId: string, quantity: string, value: string, low = false) =>
  ({
    warehouseId,
    itemId,
    itemName: '',
    unit: 'pc',
    quantity,
    averageCost: '1.0000',
    value,
    low,
  }) satisfies StockLevel;
const LEVELS = [
  level(BASMATI.id, 'w1', '10.500', '21.00'),
  level(BASMATI.id, 'w2', '2.000', '4.00', true),
  level(COLA.id, 'w1', '0.000', '0.00'),
  level(FLOUR.id, 'w1', '-1.250', '-2.50'),
];

describe('inventory overview (ADR 0048)', () => {
  const rows = itemRows([BASMATI, FLOUR, COLA, LOOSE, GONE, SHIRT, SHIRT_S], LEVELS);

  it('sums each active item over the warehouses shown, exactly; parents with variants hold none', () => {
    expect(rows.map((r) => [r.item.name, r.quantity, r.value, r.low])).toEqual([
      ['Basmati', '12.500', '25.00', true],
      ['Flour', '-1.250', '-2.50', false],
      ['Cola', '0.000', '0.00', false],
      ['Loose', '0.000', '0.00', false],
      ['Shirt S', '0.000', '0.00', false],
    ]);
    expect(sumDecimals(['0.10', '0.20', '-0.05'], 2)).toBe('0.25');
  });

  it('filters low and out of stock', () => {
    expect(rows.filter((r) => inStockState(r, 'low')).map((r) => r.item.name)).toEqual(['Basmati']);
    expect(rows.filter((r) => inStockState(r, 'out')).map((r) => r.item.name)).toEqual([
      'Flour',
      'Cola',
      'Loose',
      'Shirt S',
    ]);
  });

  it('tiles: all items, top-level categories in menu order with their secondary ones, then uncategorized', () => {
    expect(
      categoryTiles(rows, CATEGORIES).map((tile) => [
        tile.selection.kind === 'category' ? tile.category?.name : tile.selection.kind,
        tile.count,
      ]),
    ).toEqual([
      ['all', 5],
      ['Food', 2],
      ['Drinks', 2],
      ['none', 1],
    ]);
  });

  it('opens a category with its secondary categories, or a secondary one alone', () => {
    const names = (selection: Parameters<typeof inSelection>[1]) =>
      rows.filter((r) => inSelection(r, selection, CATEGORIES)).map((r) => r.item.name);
    expect(names({ kind: 'category', id: FOOD.id })).toEqual(['Basmati', 'Flour']);
    expect(names({ kind: 'category', id: RICE.id })).toEqual(['Basmati']);
    expect(names({ kind: 'none' })).toEqual(['Loose']);
    expect(secondaryCategories(CATEGORIES, FOOD.id)).toEqual([RICE]);
    expect(categoryPath(CATEGORIES, RICE.id)).toBe('Food › Rice');
  });

  it('writes CSV Excel opens: a byte order mark, quoted cells where needed', () => {
    const csv = toCsv(['Item', 'Value'], [['Rice, "basmati"', '25.00']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('Item,Value\r\n"Rice, ""basmati""",25.00\r\n');
  });
});
