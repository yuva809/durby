import { describe, expect, it } from 'vitest';
import { BRAND_MAX_LENGTH } from './inventory';
import { checkItemRows, IMPORT_TEMPLATES, resolveCategory } from './imports';

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
      'category',
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

describe('item import: category', () => {
  const categories = [
    { id: 'food', name: 'Food', parentId: null },
    { id: 'oil', name: 'Oil', parentId: 'food' },
    { id: 'drinks', name: 'Drinks', parentId: null },
    { id: 'drinks-oil', name: 'Oil', parentId: 'drinks' },
    { id: 'tea', name: 'Tea', parentId: 'drinks' },
    { id: 'ghee', name: 'Oil / Ghee', parentId: null },
    { id: 'rice', name: 'Rice', parentId: null },
  ];

  it('finds a category by name, ignoring case and spaces', () => {
    expect(resolveCategory('rice', categories)).toEqual({ id: 'rice' });
    expect(resolveCategory('  TEA ', categories)).toEqual({ id: 'tea' });
  });

  it('finds a nested category by its path', () => {
    expect(resolveCategory('Drinks / Oil', categories)).toEqual({ id: 'drinks-oil' });
    expect(resolveCategory('food/oil', categories)).toEqual({ id: 'oil' });
    expect(resolveCategory('Drinks / Tea', categories)).toEqual({ id: 'tea' });
  });

  it('takes the whole text as a name first, so a name may contain a slash', () => {
    expect(resolveCategory('Oil / Ghee', categories)).toEqual({ id: 'ghee' });
    // With no category of that name, the text is read as a path.
    expect(resolveCategory('Food / Oil / Ghee', categories)).toBe('unknown');
  });

  it('is unknown for a name that matches nothing, and ambiguous for a bare name used twice', () => {
    expect(resolveCategory('Dairy', categories)).toBe('unknown');
    expect(resolveCategory('Drinks / Rice', categories)).toBe('unknown');
    expect(resolveCategory('Oil', categories)).toBe('ambiguous');
  });

  it('checks the rows against the categories it is given', () => {
    const rows = [
      { ...base, name: 'A', category: 'Rice' },
      { ...base, name: 'B', category: 'Drinks / Oil' },
      { ...base, name: 'C', category: '' },
      { ...base, name: 'D', category: 'Dairy' },
      { ...base, name: 'E', category: 'Oil' },
    ];
    expect(checkItemRows(rows, undefined, { categories })).toEqual([
      { row: 4, field: 'category', problem: 'unknown' },
      { row: 5, field: 'category', problem: 'ambiguous' },
    ]);
    // Without categories to check against (not loaded yet) the cell is not judged.
    expect(checkItemRows(rows)).toEqual([]);
  });
});
