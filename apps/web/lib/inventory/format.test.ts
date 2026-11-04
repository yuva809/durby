import { describe, expect, it } from 'vitest';
import {
  isQuantity,
  isSignedQuantity,
  isUnitCost,
  lineValue,
  shortQuantity,
  sumValues,
} from './format';

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
