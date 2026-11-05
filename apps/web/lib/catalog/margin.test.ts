import { describe, expect, it } from 'vitest';
import { marginPercent } from './margin';

describe('marginPercent', () => {
  it("uses the product's own VAT rate on the net price", () => {
    // 11.90 gross at 19 % is 10.00 net: cost 3.00 leaves 70 %.
    expect(marginPercent('11.90', '19.00', '3.00')).toBe(70);
    // 10.70 gross at 7 % is 10.00 net.
    expect(marginPercent('10.70', '7.00', '3.00')).toBe(70);
    expect(marginPercent('10.00', '0.00', '2.50')).toBe(75);
  });

  it('goes negative when the dish costs more than it earns, and is null without a price', () => {
    expect(marginPercent('5.00', '0', '6.00')).toBe(-20);
    expect(marginPercent('0.00', '19', '1.00')).toBeNull();
  });
});
