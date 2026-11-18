import { describe, expect, it } from 'vitest';
import {
  compareQuantities,
  differsByRounding,
  isQuantity,
  isSignedQuantity,
  isUnitCost,
  lineValue,
  scaledQuantity,
  shortQuantity,
  sumValues,
} from './format';

describe('production preview math (ADR 0038)', () => {
  it('scales a bill quantity by wanted ÷ output, to 3 decimals half up like the api', () => {
    expect(scaledQuantity('2.000', '3', '1.000')).toBe('6.000');
    expect(scaledQuantity('0.100', '3', '1.000')).toBe('0.300');
    expect(scaledQuantity('0.001', '1.5', '1')).toBe('0.002');
    expect(scaledQuantity('1', '1', '3')).toBe('0.333');
  });

  it('refuses entries that are not quantities, or an output of zero', () => {
    expect(scaledQuantity('1', 'x', '1')).toBeNull();
    expect(scaledQuantity('1', '1', '0')).toBeNull();
  });

  it('compares quantities exactly', () => {
    expect(compareQuantities('4.500', '6.000')).toBeLessThan(0);
    expect(compareQuantities('6', '6.000')).toBe(0);
    expect(compareQuantities('10.001', '10')).toBeGreaterThan(0);
  });
});

describe('inventory form math', () => {
  it('values a line exactly, to cents, half away from zero', () => {
    expect(lineValue('10', '2.5')).toBe('25.00');
    expect(lineValue('1.5', '3.3333')).toBe('5.00');
    expect(lineValue('0.333', '1.5')).toBe('0.50');
    expect(lineValue('-1.5', '3')).toBe('-4.50');
    expect(lineValue('1.0005', '1')).toBeNull();
    expect(lineValue('abc', '1')).toBeNull();
  });

  it('sums values', () => {
    expect(sumValues(['25.00', '10.80', '-4.50'])).toBe('31.30');
    expect(sumValues([])).toBe('0.00');
  });

  it('checks entries like the api', () => {
    expect(isQuantity('2.125')).toBe(true);
    expect(isQuantity('0')).toBe(false);
    expect(isQuantity('-1')).toBe(false);
    expect(isSignedQuantity('-1.5')).toBe(true);
    expect(isSignedQuantity('0.000')).toBe(false);
    expect(isUnitCost('0.4567')).toBe(true);
    expect(isUnitCost('0.45678')).toBe(false);
  });

  it('shortens quantities', () => {
    expect(shortQuantity('10.500')).toBe('10.5');
    expect(shortQuantity('3.000')).toBe('3');
    expect(shortQuantity('-2.250')).toBe('-2.25');
  });
});

describe('totals apart only by rounding piece prices (ADR 0058)', () => {
  // 101.50 for 400 pieces is 0.25375 a piece: kept as 0.2538, the line is 101.52.
  const pieces = [
    { quantity: '400', unitCost: '0.2538' },
    { quantity: '48', unitCost: '2.51' },
  ];

  it('allows half a cent plus half a ten-thousandth per piece, for costs with more than 2 decimals', () => {
    expect(differsByRounding('222.00', '221.98', pieces)).toBe(true);
    expect(differsByRounding('221.96', '221.98', pieces)).toBe(true);
    expect(differsByRounding('222.01', '221.98', pieces)).toBe(false);
  });

  it('is not rounding when equal, priced in cents, or not amounts', () => {
    expect(differsByRounding('221.98', '221.98', pieces)).toBe(false);
    expect(differsByRounding('120.49', '120.48', [{ quantity: '48', unitCost: '2.51' }])).toBe(
      false,
    );
    expect(differsByRounding('x', '1.00', pieces)).toBe(false);
  });
});
