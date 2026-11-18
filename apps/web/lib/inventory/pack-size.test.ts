import { describe, expect, it } from 'vitest';
import { formatPackSize, packFields, packProblems, parsePackSize } from './pack-size';

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
