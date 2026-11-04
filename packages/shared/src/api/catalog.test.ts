import { describe, expect, it } from 'vitest';
import {
  checkImportRows,
  importProductsRequestSchema,
  importRowKey,
  menuNumberSchema,
} from './catalog';

const row = (over: Partial<Record<string, string>> = {}) => ({
  category: 'Drinks',
  name: 'Soju',
  price: '7.00',
  taxRate: '19',
  ...over,
});

describe('checkImportRows', () => {
  it('accepts valid rows', () => {
    expect(checkImportRows([row(), row({ name: 'Beer', description: 'Cold' })])).toEqual([]);
  });

  it('reports every problem with its 1-based row and field', () => {
    expect(
      checkImportRows([
        row({ category: ' ', price: '' }),
        row({ name: 'x'.repeat(101), price: '4,50', taxRate: '120' }),
        row({ description: 'd'.repeat(501) }),
      ]),
    ).toEqual([
      { row: 1, field: 'category', problem: 'required' },
      { row: 1, field: 'price', problem: 'required' },
      { row: 2, field: 'name', problem: 'too_long' },
      { row: 2, field: 'price', problem: 'invalid' },
      { row: 2, field: 'taxRate', problem: 'invalid' },
      { row: 3, field: 'description', problem: 'too_long' },
    ]);
  });

  it('finds the same category and name twice, ignoring case and spaces', () => {
    expect(checkImportRows([row(), row({ category: ' drinks', name: 'SOJU ' })])).toEqual([
      { row: 2, field: 'name', problem: 'duplicate' },
    ]);
    expect(importRowKey({ category: 'A', name: 'b' })).toBe(
      importRowKey({ category: ' a ', name: 'B' }),
    );
  });
});

describe('menu numbers (ADR 0029)', () => {
  it('takes 1 to 6 letters, digits, dots and dashes, starting with a letter or digit', () => {
    for (const ok of ['1', '12', '12a', 'D4', 'B-3', '10.1', ' 7 ', '123456'])
      expect(menuNumberSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', ' ', '-1', '1234567', '12 a', '#4', 'ä1'])
      expect(menuNumberSchema.safeParse(bad).success, bad).toBe(false);
    expect(menuNumberSchema.parse(' 7 ')).toBe('7');
  });

  it('checks import numbers: invalid, and the same number twice ignoring case', () => {
    expect(
      checkImportRows([
        row({ number: '12a' }),
        row({ name: 'Beer', number: '12A' }),
        row({ name: 'Wine', number: 'no way' }),
        row({ name: 'Water', number: ' ' }),
      ]),
    ).toEqual([
      { row: 2, field: 'number', problem: 'duplicate' },
      { row: 3, field: 'number', problem: 'invalid' },
    ]);
  });

  it('lets a row carry the station of the category it creates', () => {
    expect(
      importProductsRequestSchema.safeParse({ rows: [{ ...row(), station: 'bar' }] }).success,
    ).toBe(true);
    expect(
      importProductsRequestSchema.safeParse({ rows: [{ ...row(), station: 'grill' }] }).success,
    ).toBe(false);
  });
});

describe('importProductsRequestSchema', () => {
  it('needs 1 to 1000 rows with known columns only', () => {
    expect(importProductsRequestSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(importProductsRequestSchema.safeParse({ rows: [row()] }).success).toBe(true);
    expect(
      importProductsRequestSchema.safeParse({ rows: Array.from({ length: 1001 }, () => row()) })
        .success,
    ).toBe(false);
    expect(importProductsRequestSchema.safeParse({ rows: [{ ...row(), sku: '1' }] }).success).toBe(
      false,
    );
  });
});
