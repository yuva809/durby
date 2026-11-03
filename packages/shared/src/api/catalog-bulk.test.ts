import { describe, expect, it } from 'vitest';
import { newPrice, productBulkRequestSchema } from './catalog-bulk';

describe('newPrice', () => {
  it.each([
    ['12.50', { mode: 'set', value: '9.9' }, '9.90'],
    ['12.50', { mode: 'add', value: '1' }, '13.50'],
    ['12.50', { mode: 'add', value: '-2.75' }, '9.75'],
    ['12.50', { mode: 'percent', value: '10' }, '13.75'],
    ['9.99', { mode: 'percent', value: '10' }, '10.99'], // 10.989 → 10.99 (half up)
    ['4.45', { mode: 'percent', value: '-10' }, '4.01'], // 4.005 → 4.01 (half up)
    ['0.05', { mode: 'percent', value: '-50' }, '0.03'], // 0.025 → 0.03
    ['18.90', { mode: 'percent', value: '0.5' }, '18.99'], // 18.9945 → 18.99
  ] as const)('%s with %o → %s', (price, change, expected) => {
    expect(newPrice(price, change)).toBe(expected);
  });

  it('refuses a price below zero or beyond the column', () => {
    expect(newPrice('2.00', { mode: 'add', value: '-2.01' })).toBeNull();
    expect(newPrice('2.00', { mode: 'percent', value: '-100' })).toBe('0.00');
    expect(newPrice('9999999999.99', { mode: 'add', value: '0.01' })).toBeNull();
  });
});

describe('productBulkRequestSchema', () => {
  const id = '0190a000-0000-7000-8000-000000000301';

  it('accepts each action and refuses bad values', () => {
    expect(
      productBulkRequestSchema.safeParse({ ids: [id], action: { kind: 'delete' } }).success,
    ).toBe(true);
    expect(
      productBulkRequestSchema.safeParse({
        ids: [id],
        action: { kind: 'price', change: { mode: 'percent', value: '-12.5' } },
      }).success,
    ).toBe(true);
    expect(
      productBulkRequestSchema.safeParse({
        ids: [id],
        action: { kind: 'price', change: { mode: 'set', value: '-1' } },
      }).success,
    ).toBe(false);
    expect(
      productBulkRequestSchema.safeParse({ ids: [id], action: { kind: 'vat', taxRate: '120' } })
        .success,
    ).toBe(false);
    expect(
      productBulkRequestSchema.safeParse({ ids: [], action: { kind: 'archive' } }).success,
    ).toBe(false);
  });
});
