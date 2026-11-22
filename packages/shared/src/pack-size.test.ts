import { describe, expect, it } from 'vitest';
import {
  formatPackSize,
  packFields,
  packProblems,
  parsePackCell,
  parsePackSize,
  unitLookup,
} from './pack-size';

describe('pack size (ADR 0055)', () => {
  it('reads "count x size unit" from an invoice description, ranges aside', () => {
    expect(parsePackSize('Bigi Mama African Catfish WG 800-1000gr IQF 1 x 4kg 20% -VN')).toEqual({
      count: '1',
      size: '4',
      unit: 'kg',
    });
    expect(parsePackSize('OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR')).toEqual({
      count: '5',
      size: '2',
      unit: 'kg',
    });
    expect(parsePackSize('Coconut milk 12×400 ML')).toEqual({
      count: '12',
      size: '400',
      unit: 'ml',
    });
    expect(parsePackSize('Palm oil 1,5 ltr')).toEqual({ count: '', size: '1.5', unit: 'l' });
    // A range alone is no pack size.
    expect(parsePackSize('Tilapia 300-500g')).toBeNull();
    expect(parsePackSize('Stockfish heads')).toBeNull();
  });

  it('shows a pack size as people write it', () => {
    expect(formatPackSize({ count: 12, size: '500.000', unit: 'g' })).toBe('12 × 500 g');
    expect(formatPackSize({ count: null, size: '4.000', unit: 'kg' })).toBe('4 kg');
    // A size without decimals keeps its zeros.
    expect(formatPackSize({ count: 12, size: '500', unit: 'ml' })).toBe('12 × 500 ml');
    expect(formatPackSize({ count: '6', size: null, unit: null })).toBe('6 ×');
    expect(formatPackSize({ count: null, size: null, unit: null })).toBe('');
  });

  it('checks a typed pack size and gives only what is set', () => {
    expect(packProblems({ count: '12', size: '0,5', unit: 'kg' })).toEqual([]);
    expect(packFields({ count: '12', size: '0,5', unit: 'kg' })).toEqual({
      packCount: 12,
      packSize: '0.5',
      packUnit: 'kg',
    });
    expect(packProblems({ count: '1.5', size: '0', unit: 'kg' })).toEqual(['count', 'size']);
    expect(packProblems({ count: '', size: '2', unit: '' })).toEqual(['unit']);
    expect(packProblems({ count: '', size: '', unit: '' })).toEqual([]);
    expect(packFields({ count: '', size: '', unit: '' })).toEqual({});
  });
});

describe('pack size cell of an import (strict, shown unit names)', () => {
  // As an organization that calls pieces "Stück" would see them.
  const labels: Record<string, string> = { pc: 'Stück', box: 'Karton' };
  const lookup = unitLookup((u) => labels[u] ?? u);

  it('reads the forms people type into one cell', () => {
    expect(parsePackCell('12 x 500 ml', lookup)).toEqual({ count: '12', size: '500', unit: 'ml' });
    expect(parsePackCell('12×400 ML', lookup)).toEqual({ count: '12', size: '400', unit: 'ml' });
    expect(parsePackCell('12x200ml', lookup)).toEqual({ count: '12', size: '200', unit: 'ml' });
    expect(parsePackCell('5kg', lookup)).toEqual({ count: '', size: '5', unit: 'kg' });
    expect(parsePackCell('1,5 ltr', lookup)).toEqual({ count: '', size: '1.5', unit: 'l' });
  });

  it('reads a bare count and "Pack of N" as the count only', () => {
    expect(parsePackCell('10', lookup)).toEqual({ count: '10', size: '', unit: '' });
    expect(parsePackCell('Pack of 6', lookup)).toEqual({ count: '6', size: '', unit: '' });
  });

  it('takes the unit by code or by the name the organization sees', () => {
    expect(parsePackCell('6 x 1 Stück', lookup)).toEqual({ count: '6', size: '1', unit: 'pc' });
    expect(parsePackCell('2 stück.', lookup)).toEqual({ count: '', size: '2', unit: 'pc' });
    expect(parsePackCell('4 KARTON', lookup)).toEqual({ count: '', size: '4', unit: 'box' });
    expect(parsePackCell('3 bag', lookup)).toEqual({ count: '', size: '3', unit: 'bag' });
  });

  it('gives null for anything else, including text around a size', () => {
    expect(parsePackCell('big pack', lookup)).toBeNull();
    expect(parsePackCell('foo 5kg', lookup)).toBeNull();
    expect(parsePackCell('5 crate', lookup)).toBeNull();
    expect(parsePackCell('5.5', lookup)).toBeNull();
    expect(parsePackCell('12 x', lookup)).toBeNull();
    expect(parsePackCell('', lookup)).toBeNull();
  });
});
