import type { StockItem } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { ordersQuery } from './api';
import {
  dayRange,
  draftTotal,
  itemLabel,
  lineTotal,
  linesValid,
  matchesOrder,
  sellableItems,
} from './form';

const item = (id: string, name: string, extra: Partial<StockItem> = {}): StockItem => ({
  id,
  name,
  sku: null,
  unit: 'pc',
  minQuantity: null,
  parentItemId: null,
  variantValues: [],
  salePrice: null,
  categoryId: null,
  archivedAt: null,
  ...extra,
});

describe('order form maths (exact cents)', () => {
  it.each([
    ['3', '12.90', '38.70'],
    ['0.333', '10', '3.33'],
    ['0.125', '0.10', '0.01'],
    ['1.005', '1.00', '1.01'],
    ['2', '0', '0.00'],
  ])('%s × %s = %s', (q, p, total) => {
    expect(lineTotal(q, p)).toBe(total);
  });

  it('leaves invalid lines out of the total and reports them', () => {
    const lines = [
      { itemId: 'a', quantity: '3', unitPrice: '12.90' },
      { itemId: 'b', quantity: 'x', unitPrice: '1' },
    ];
    expect(lineTotal('x', '1')).toBeNull();
    expect(draftTotal(lines)).toBe('38.70');
    expect(linesValid(lines)).toBe(false);
    expect(linesValid([{ itemId: 'a', quantity: '0', unitPrice: '1' }])).toBe(false);
    expect(linesValid([{ itemId: 'a', quantity: '1.5', unitPrice: '2.5' }])).toBe(true);
  });
});

describe('sellable items', () => {
  it('drops archived items and parents with variants, names variants after their parent', () => {
    const items = [
      item('1', 'T-shirt'),
      item('2', 'T-shirt Large', { parentItemId: '1', variantValues: ['Large'] }),
      item('3', 'Rice'),
      item('4', 'Old', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const sellable = sellableItems(items);
    expect(sellable.map((i) => i.id)).toEqual(['3', '2']);
    expect(itemLabel(sellable[1]!, items)).toBe('T-shirt · Large');
  });
});

describe('filters', () => {
  it('turns days into instants with an exclusive end', () => {
    const range = dayRange('2026-11-01', '2026-11-01');
    const hours = (new Date(range.to!).getTime() - new Date(range.from!).getTime()) / 3600_000;
    expect(hours).toBeGreaterThanOrEqual(23);
    expect(hours).toBeLessThanOrEqual(25);
    expect(dayRange('', 'nope')).toEqual({});
  });

  it('searches number and customer', () => {
    const order = { number: 'SO-2026-000012', customerName: 'Lotus Mart' };
    expect(matchesOrder(order, '000012')).toBe(true);
    expect(matchesOrder(order, 'lotus')).toBe(true);
    expect(matchesOrder(order, 'other')).toBe(false);
    expect(matchesOrder(order, '  ')).toBe(true);
  });

  it('builds the list query', () => {
    expect(ordersQuery({ status: 'draft', locationId: 'l1' }, 'c1')).toBe(
      '?status=draft&locationId=l1&limit=50&cursor=c1',
    );
  });
});
