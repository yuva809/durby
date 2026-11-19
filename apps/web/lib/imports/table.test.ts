import { checkItemRows, checkOpeningStockRows, type ItemImportRow } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { isExcel, readRows, readTableRows, templateCsv } from './table';

describe('readRows (Import Data)', () => {
  it('reads the template columns in any order, with loose headers and semicolons', () => {
    const result = readRows(
      'items',
      '﻿Unit;Name;Sale price;Min quantity;Extra\npc;Rice 5 kg;12,90;2;x\n;;;;\nkg;Sugar;;;\n',
    );
    expect(result).toEqual({
      ok: true,
      rows: [
        { name: 'Rice 5 kg', sku: '', unit: 'pc', minQuantity: '2', salePrice: '12.90' },
        { name: 'Sugar', sku: '', unit: 'kg', minQuantity: '', salePrice: '' },
      ],
    });
  });

  it('accepts aliases and names missing columns', () => {
    expect(readRows('customers', 'Customer,Mobile\nLotus Mart,+60 12\n')).toMatchObject({
      ok: true,
      rows: [{ name: 'Lotus Mart', phone: '+60 12' }],
    });
    expect(readRows('opening_stock', 'warehouse,item\nMain,Rice\n')).toEqual({
      ok: false,
      problem: { kind: 'missingColumns', columns: ['quantity', 'unit_cost'] },
    });
    expect(readRows('categories', '')).toEqual({ ok: false, problem: { kind: 'empty' } });
    expect(readRows('categories', 'name\n\n')).toEqual({ ok: false, problem: { kind: 'empty' } });
  });

  it('writes templates that read back', () => {
    expect(templateCsv('opening_stock')).toBe('warehouse,item,quantity,unit_cost\r\n');
    expect(
      readRows('opening_stock', `${templateCsv('opening_stock')}Main,R-1,3,1.5`),
    ).toMatchObject({
      ok: true,
      rows: [{ warehouse: 'Main', item: 'R-1', quantity: '3', unitCost: '1.5' }],
    });
  });
});

describe('shared row checks', () => {
  it('flags bad units, prices, quantities and duplicates', () => {
    const rows: ItemImportRow[] = [
      { name: 'Rice', unit: 'pc', salePrice: '1.999' },
      { name: 'rice', unit: 'crate' },
      { name: 'Oil', sku: 'O-1', unit: 'l', minQuantity: '-1' },
    ];
    expect(checkItemRows(rows)).toEqual([
      { row: 1, field: 'salePrice', problem: 'invalid' },
      { row: 2, field: 'name', problem: 'duplicate' },
      { row: 2, field: 'unit', problem: 'invalid' },
      { row: 3, field: 'minQuantity', problem: 'invalid' },
    ]);
  });

  it('checks opening stock references when it knows them', () => {
    const known = { warehouses: new Set(['main']), items: new Set(['rice', 'r-1']) };
    expect(
      checkOpeningStockRows(
        [
          { warehouse: 'Main', item: 'R-1', quantity: '3', unitCost: '1.5' },
          { warehouse: 'Cold room', item: 'Fish', quantity: '0', unitCost: 'x' },
        ],
        known,
      ),
    ).toEqual([
      { row: 2, field: 'warehouse', problem: 'unknown' },
      { row: 2, field: 'item', problem: 'unknown' },
      { row: 2, field: 'quantity', problem: 'invalid' },
      { row: 2, field: 'unitCost', problem: 'invalid' },
    ]);
  });
});

describe('readTableRows (Excel and CSV alike)', () => {
  it('reads a table the same way as the CSV text it came from', () => {
    expect(readTableRows('categories', [['Category'], ['Fish'], [''], ['Rice']])).toEqual({
      ok: true,
      rows: [{ name: 'Fish' }, { name: 'Rice' }],
    });
    expect(readTableRows('categories', [])).toEqual({ ok: false, problem: { kind: 'empty' } });
  });

  it('knows Excel files by name', () => {
    expect(isExcel('Stock.XLSX')).toBe(true);
    expect(isExcel('stock.xls')).toBe(false);
    expect(isExcel('stock.csv')).toBe(false);
  });
});
