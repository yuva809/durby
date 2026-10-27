import { describe, expect, it } from 'vitest';
import { lineTotal, orderTotals } from './order-totals';

describe('lineTotal', () => {
  it('multiplies the gross unit price, also for void lines', () => {
    expect(lineTotal('6.90', 2)).toBe('13.80');
    expect(lineTotal('3.80', -1)).toBe('-3.80');
    expect(lineTotal('0.10', 3)).toBe('0.30');
  });
});

describe('orderTotals', () => {
  it('sums gross and splits it per VAT rate into net and tax, rounded to cents', () => {
    const totals = orderTotals([
      { unitPrice: '6.90', taxRate: '7.00', quantity: 2 },
      { unitPrice: '3.80', taxRate: '19.00', quantity: 1 },
    ]);
    expect(totals).toEqual({
      itemCount: 3,
      gross: '17.60',
      byTaxRate: [
        { taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' },
        { taxRate: '19.00', gross: '3.80', net: '3.19', tax: '0.61' },
      ],
    });
  });

  it('subtracts voids and drops a rate with nothing left', () => {
    const totals = orderTotals([
      { unitPrice: '6.90', taxRate: '7.00', quantity: 2 },
      { unitPrice: '3.80', taxRate: '19.00', quantity: 1 },
      { unitPrice: '3.80', taxRate: '19.00', quantity: -1 },
    ]);
    expect(totals).toEqual({
      itemCount: 2,
      gross: '13.80',
      byTaxRate: [{ taxRate: '7.00', gross: '13.80', net: '12.90', tax: '0.90' }],
    });
  });

  it('is zero for no lines', () => {
    expect(orderTotals([])).toEqual({ itemCount: 0, gross: '0.00', byTaxRate: [] });
  });

  it('never loses a cent to floating point', () => {
    const totals = orderTotals(
      Array.from({ length: 10 }, () => ({ unitPrice: '0.10', taxRate: '19.00', quantity: 1 })),
    );
    expect(totals.gross).toBe('1.00');
  });
});
