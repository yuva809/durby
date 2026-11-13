import { describe, expect, it } from 'vitest';
import { allocateDiscount } from './discounts';

const t = (id: string, gross: string, taxRate = '7.00') => ({ orderLineId: id, taxRate, gross });

describe('allocateDiscount', () => {
  it('takes a percentage of each line, rounded to cents', () => {
    expect(
      allocateDiscount([t('a', '6.90'), t('b', '3.80', '19.00')], 'percent', '10', true),
    ).toEqual([
      { orderLineId: 'a', taxRate: '7.00', amount: '-0.69' },
      { orderLineId: 'b', taxRate: '19.00', amount: '-0.38' },
    ]);
  });

  it('comps a line at 100 %', () => {
    expect(allocateDiscount([t('a', '6.90')], 'percent', '100', false)).toEqual([
      { orderLineId: 'a', taxRate: '7.00', amount: '-6.90' },
    ]);
  });

  it('gives an amount to one line', () => {
    expect(allocateDiscount([t('a', '6.90')], 'amount', '2.50', false)).toEqual([
      { orderLineId: 'a', taxRate: '7.00', amount: '-2.50' },
    ]);
  });

  it('spreads an amount over the whole order so the cents add up exactly', () => {
    const lines = allocateDiscount(
      [t('a', '10.00'), t('b', '10.00'), t('c', '10.00')],
      'amount',
      '1.00',
      true,
    );
    expect(lines!.map((l) => l.amount)).toEqual(['-0.34', '-0.33', '-0.33']);
    const sum = lines!.reduce((n, l) => n + Math.round(Number(l.amount) * 100), 0);
    expect(sum).toBe(-100);
  });

  it('refuses what does not fit', () => {
    expect(allocateDiscount([t('a', '6.90')], 'amount', '7.00', false)).toBeNull();
    expect(allocateDiscount([t('a', '6.90')], 'percent', '101', true)).toBeNull();
    expect(allocateDiscount([t('a', '6.90')], 'percent', '0', true)).toBeNull();
    expect(allocateDiscount([t('a', '0.00')], 'percent', '10', true)).toBeNull();
    expect(allocateDiscount([t('a', '6.90'), t('b', '3.80')], 'amount', '2', false)).toBeNull();
  });
});
