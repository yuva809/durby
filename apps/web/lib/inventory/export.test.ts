import { createTranslator } from '@durby/i18n';
import type { ProductCategory, StockItem } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { toCsv } from '../csv';
import { csvRows, inventoryTable, pdfBlob, xlsxBlob } from './export';
import type { ItemRow } from './overview';

const t = createTranslator('en', {});
const id = (n: number) => `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

const RICE = { id: id(1), name: 'African Item', parentId: null } as ProductCategory;
const BASMATI = { id: id(2), name: 'Rice', parentId: id(1) } as ProductCategory;
const categories = [RICE, BASMATI];

function row(name: string, over: Partial<ItemRow> = {}, item: Partial<StockItem> = {}): ItemRow {
  return {
    item: { id: id(50), name, sku: null, unit: 'kg', categoryId: id(2), ...item } as StockItem,
    quantity: '12.500',
    value: '31.25',
    low: false,
    expiresOn: null,
    ...over,
  };
}

const ROWS = [
  row('Basmati rice'),
  row(
    'Crème fraîche',
    { quantity: '2.000', value: '5.10', low: true },
    { sku: 'CF-1', unit: 'pc', categoryId: null },
  ),
];

describe('inventoryTable', () => {
  it('has the columns of the page, values and a total for people who see prices', () => {
    const table = inventoryTable(ROWS, { t, prices: true, categories });
    expect(table.header).toEqual([
      'Item',
      'Article no.',
      'Category',
      'Unit',
      'Quantity',
      'Value',
      'Low stock',
    ]);
    expect(table.rows[0]!.map((c) => c.text)).toEqual([
      'Basmati rice',
      '',
      'African Item › Rice',
      t('inventory.units.kg'),
      '12.5',
      '31.25',
      '',
    ]);
    expect(table.rows[1]![6]!.text).toBe('Yes');
    // Numbers stay numbers for Excel: quantity with up to 3 decimals, value with 2.
    expect(table.rows[0]![4]).toMatchObject({ number: '12.500', decimals: 3 });
    expect(table.rows[0]![5]).toMatchObject({ number: '31.25', decimals: 2, money: true });
    expect(table.total).toBe('36.35');
  });

  it('leaves out value and total without prices (ADR 0060)', () => {
    const table = inventoryTable(ROWS, { t, prices: false, categories });
    expect(table.header).not.toContain('Value');
    expect(table.rows[0]).toHaveLength(6);
    expect(table.total).toBeNull();
  });

  it('gives CSV the same text as before', () => {
    const table = inventoryTable(ROWS, { t, prices: true, categories });
    const csv = toCsv(table.header, csvRows(table));
    expect(csv).toContain('Basmati rice,,African Item › Rice,');
    expect(csv).toContain('Crème fraîche,CF-1,,');
  });
});

describe('files', () => {
  const table = inventoryTable(ROWS, { t, prices: true, categories });
  const heading = {
    title: 'Inventory',
    lines: ['Demo Bistro', 'Printed 26 Nov 2026, 10:00', 'Warehouse: All warehouses'],
    totalLabel: 'Total',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    money: (amount: string) => `€${amount}`,
  };

  it('writes an Excel workbook with numeric cells', async () => {
    const blob = await xlsxBlob(table, { sheet: 'Inventory', totalLabel: 'Total' });
    const { default: readXlsxFile } = await import('read-excel-file/universal');
    const [sheet] = await readXlsxFile(await blob.arrayBuffer());
    expect(sheet!.sheet).toBe('Inventory');
    const rows = sheet!.data;
    expect(rows[0]).toEqual(table.header);
    // Numbers, so sums work in Excel.
    expect(rows[1]!.slice(4, 6)).toEqual([12.5, 31.25]);
    expect(rows[3]![0]).toBe('Total');
    expect(rows[3]![5]).toBe(36.35);
  });

  it('writes a PDF with the rows, the total and page numbers', async () => {
    const blob = await pdfBlob(table, heading);
    const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
    expect(text.startsWith('%PDF')).toBe(true);
    expect(text).toContain('Basmati rice');
    expect(text).toContain('Page 1 of 1');
    expect(text).toContain('36.35');
  });
});
