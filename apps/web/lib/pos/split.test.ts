import { describe, expect, it } from 'vitest';
import { centsOf, centsText, equalShare, pickedTotal, sumMoney } from './split';

describe('split previews (exact cents)', () => {
  it('reads and writes money strings', () => {
    expect(centsOf('12.40')).toBe(1240n);
    expect(centsOf('7')).toBe(700n);
    expect(centsOf('0.5')).toBe(50n);
    expect(centsOf('-1.05')).toBe(-105n);
    expect(centsOf('abc')).toBe(0n);
    expect(centsText(1240n)).toBe('12.40');
    expect(centsText(5n)).toBe('0.05');
  });

  it('totals the picked portions at their unit prices', () => {
    const lines = [
      { id: 'soup', unitPrice: '6.90' },
      { id: 'water', unitPrice: '2.50' },
      { id: 'tea', unitPrice: '3.10' },
    ];
    expect(pickedTotal(lines, { soup: 2, water: 1 })).toEqual({ items: 3, gross: '16.30' });
    expect(pickedTotal(lines, {})).toEqual({ items: 0, gross: '0.00' });
  });

  it('shows what each guest pays, and whether some pay a cent more', () => {
    expect(equalShare('30.00', 3)).toEqual({ each: '10.00', uneven: false });
    expect(equalShare('10.00', 3)).toEqual({ each: '3.33', uneven: true });
  });

  it('adds money exactly', () => {
    expect(sumMoney(['0.10', '0.20', '12.35'])).toBe('12.65');
  });
});
