import { describe, expect, it } from 'vitest';
import { BRAND_MAX_LENGTH } from './inventory';
import { checkItemRows, IMPORT_TEMPLATES } from './imports';

const base = { name: 'Coconut milk', unit: 'pc' };
const labelOf = (u: string) => (u === 'pc' ? 'Stück' : u);

describe('item import: brand and pack size', () => {
  it('has the columns in the template', () => {
    expect(IMPORT_TEMPLATES.items).toEqual([
      'name',
      'sku',
      'unit',
      'brand',
      'pack_size',
      'min_quantity',
      'sale_price',
    ]);
  });

  it('accepts empty and valid cells', () => {
    const rows = [
      { ...base, brand: '', packSize: '' },
      { ...base, name: 'A', brand: 'Chaokoh', packSize: '12 x 500 ml' },
      { ...base, name: 'B', packSize: '12x200ml' },
      { ...base, name: 'C', packSize: '10' },
      { ...base, name: 'D', packSize: '5kg' },
      { ...base, name: 'E', packSize: '6 x 1 Stück' },
    ];
    expect(checkItemRows(rows, labelOf)).toEqual([]);
  });

  it('reports a pack size that does not parse or breaks the item rules', () => {
    const rows = [
      { ...base, name: 'A', packSize: 'big pack' },
      { ...base, name: 'B', packSize: '0 kg' },
      { ...base, name: 'C', packSize: '1.2345 kg' },
      { ...base, name: 'D', packSize: '0 x 5 kg' },
      { ...base, name: 'E', packSize: '100001 x 5 kg' },
      { ...base, name: 'F', packSize: '6 x 1 Stück' },
    ];
    // Without the shown names, "Stück" is no unit.
    expect(checkItemRows(rows)).toEqual([
      { row: 1, field: 'packSize', problem: 'invalid' },
      { row: 2, field: 'packSize', problem: 'invalid' },
      { row: 3, field: 'packSize', problem: 'invalid' },
      { row: 4, field: 'packSize', problem: 'invalid' },
      { row: 5, field: 'packSize', problem: 'invalid' },
      { row: 6, field: 'packSize', problem: 'invalid' },
    ]);
  });

  it('limits the brand', () => {
    expect(checkItemRows([{ ...base, brand: 'x'.repeat(BRAND_MAX_LENGTH + 1) }])).toEqual([
      { row: 1, field: 'brand', problem: 'too_long' },
    ]);
  });
});
