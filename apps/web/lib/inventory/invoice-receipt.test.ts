import type { StockItem } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import type { InvoiceLine } from './invoice-pdf';
import { matchInvoice, NEW_ITEM, receiptRequest, rowProblems } from './invoice-receipt';

const id = (n: number) => `0190a000-0000-7000-8000-0000000050${String(n).padStart(2, '0')}`;
const item = (n: number, name: string, sku: string | null, extra: Partial<StockItem> = {}) =>
  ({
    id: id(n),
    name,
    sku,
    unit: 'pc',
    minQuantity: null,
    parentItemId: null,
    variantValues: [],
    salePrice: null,
    categoryId: null,
    archivedAt: null,
    ...extra,
  }) satisfies StockItem;
const line = (code: string | null, description: string, quantity = '1.00', price = '2.00') =>
  ({
    code,
    description,
    quantity,
    unitPrice: price,
    vatRate: '0',
    total: price,
    checks: true,
  }) satisfies InvoiceLine;

const CATFISH = item(1, 'Catfish 4kg', '1103-002');
const TILAPIA = item(2, 'Ultimate Taste Red Tilapia Steaks', null);
const OLD = item(3, 'Old', '9999-001', { archivedAt: '2026-11-01T00:00:00.000Z' });

describe('vendor invoice review (ADR 0049)', () => {
  const lines = [
    line('1103-002', 'Bigi Mama African Catfish 1 x 4kg', '50.00', '11.00'),
    line('2252-001', 'ultimate taste  red tilapia steaks'),
    line('9999-001', 'Something archived'),
    line(null, 'Brand new thing'),
  ];

  it('matches by SKU, then exact name, else new; archived items never', () => {
    expect(matchInvoice(lines, [CATFISH, TILAPIA, OLD]).map((r) => r.target)).toEqual([
      CATFISH.id,
      TILAPIA.id,
      NEW_ITEM,
      NEW_ITEM,
    ]);
  });

  it('flags bad amounts, an item twice, and new items for those who cannot create them', () => {
    const rows = matchInvoice(lines, [CATFISH, TILAPIA]);
    rows[1] = { ...rows[1]!, target: CATFISH.id };
    rows[2] = { ...rows[2]!, quantity: '0' };
    rows[3] = { ...rows[3]!, unitCost: '1.23456' };
    expect(rowProblems(rows, false)).toEqual([
      ['duplicate'],
      ['duplicate'],
      ['quantity', 'newNotAllowed'],
      ['unitCost', 'newNotAllowed'],
    ]);
    // Left out lines have no problems.
    const left = rows[2]!;
    expect(rowProblems([{ ...left, include: false }], false)).toEqual([[]]);
  });

  it('builds one request: existing items by id, new ones with the supplier code as SKU', () => {
    const rows = matchInvoice(lines, [CATFISH, TILAPIA]);
    rows[2] = { ...rows[2]!, include: false };
    expect(
      receiptRequest({
        rows,
        warehouseId: id(90),
        supplier: ' Bonesca ',
        note: 'Order 108666 · 10-11-2026',
        newItemUnit: 'pc',
        newItemCategoryId: id(80),
      }),
    ).toEqual({
      warehouseId: id(90),
      supplier: 'Bonesca',
      note: 'Order 108666 · 10-11-2026',
      lines: [
        { itemId: CATFISH.id, quantity: '50.00', unitCost: '11.00' },
        { itemId: TILAPIA.id, quantity: '1.00', unitCost: '2.00' },
        {
          newItem: { name: 'Brand new thing', unit: 'pc', categoryId: id(80) },
          quantity: '1.00',
          unitCost: '2.00',
        },
      ],
    });
  });
});
