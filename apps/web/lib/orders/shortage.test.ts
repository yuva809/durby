import { describe, expect, it } from 'vitest';
import { exceedsStock, pickPlan, shownStock } from './shortage';

describe('picking a branch request against stock', () => {
  it('starts with the approved quantity when it is in stock', () => {
    expect(pickPlan('5.000', '10.000')).toEqual({ initial: '5', short: null });
    expect(pickPlan('5.000', '5')).toEqual({ initial: '5', short: null });
  });

  it('starts with what is there and says how much is missing', () => {
    expect(pickPlan('5.000', '3.000')).toEqual({ initial: '3', short: '2' });
    expect(pickPlan('2.5', '0.000')).toEqual({ initial: '0', short: '2.5' });
    // Below zero (allowed at some locations) counts as none.
    expect(pickPlan('4', '-1.500')).toEqual({ initial: '0', short: '4' });
  });

  it('keeps the approved quantity when the stock is unknown', () => {
    expect(pickPlan('5.000', null)).toEqual({ initial: '5', short: null });
  });

  it('knows a quantity beyond the stock', () => {
    expect(exceedsStock('4', '3.000')).toBe(true);
    expect(exceedsStock('3', '3.000')).toBe(false);
    expect(exceedsStock('1', '-2')).toBe(true);
    expect(exceedsStock('x', '3')).toBe(false);
    expect(shownStock('-2.000')).toBe('0');
    expect(shownStock('4.500')).toBe('4.5');
  });
});
