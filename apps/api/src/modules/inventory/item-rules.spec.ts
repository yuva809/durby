import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  combinations,
  componentNeeds,
  outputUnitCost,
  toBaseUnits,
  variantName,
} from './item-rules';

const d = (value: string) => new Decimal(value);

describe('toBaseUnits (ADR 0038)', () => {
  it('converts a case of 24 at 12.00 into 24 pieces at 0.50', () => {
    const base = toBaseUnits(d('1'), d('12'), d('24'))!;
    expect(base.quantity.toFixed(3)).toBe('24.000');
    expect(base.unitCost.toFixed(4)).toBe('0.5000');
  });

  it('rounds the quantity to 3 and the cost to 4 decimals, half up', () => {
    const base = toBaseUnits(d('1.5'), d('10'), d('0.3333'))!;
    expect(base.quantity.toFixed(3)).toBe('0.500');
    expect(base.unitCost.toFixed(4)).toBe('30.0030');
  });

  it('refuses a line that converts to nothing', () => {
    expect(toBaseUnits(d('0.001'), d('1'), d('0.1'))).toBeNull();
  });
});

describe('combinations', () => {
  it('takes one value per list in list order', () => {
    expect(
      combinations([
        ['S', 'L'],
        ['red', 'blue'],
      ]),
    ).toEqual([
      ['S', 'red'],
      ['S', 'blue'],
      ['L', 'red'],
      ['L', 'blue'],
    ]);
  });

  it('gives the values of a single list', () => {
    expect(combinations([['0.33 l', '0.5 l']])).toEqual([['0.33 l'], ['0.5 l']]);
  });
});

describe('variantName', () => {
  it('appends the values to the parent name', () => {
    expect(variantName('Cola', ['0.5 l'])).toBe('Cola · 0.5 l');
    expect(variantName('Shirt', ['L', 'Blue'])).toBe('Shirt · L / Blue');
  });

  it('shortens the parent name to stay within 100 characters', () => {
    const name = variantName('x'.repeat(100), ['Large']);
    expect(name).toHaveLength(100);
    expect(name.endsWith(' · Large')).toBe(true);
  });
});

describe('componentNeeds', () => {
  const bill = {
    outputQuantity: d('2'),
    lines: [
      { itemId: 'tomato', quantity: d('4') },
      { itemId: 'oil', quantity: d('0.2') },
      { itemId: 'salt', quantity: d('0.001') },
    ],
  };

  it('scales every component by wanted ÷ output quantity', () => {
    expect(componentNeeds(bill, d('3')).map((l) => [l.itemId, l.quantity.toFixed(3)])).toEqual([
      ['tomato', '6.000'],
      ['oil', '0.300'],
      ['salt', '0.002'],
    ]);
  });

  it('leaves out components that round to zero', () => {
    expect(componentNeeds(bill, d('0.5')).map((l) => l.itemId)).toEqual(['tomato', 'oil']);
  });
});

describe('outputUnitCost', () => {
  it('spreads the components’ value over the quantity made', () => {
    expect(outputUnitCost([d('12.00'), d('1.50')], d('3')).toFixed(4)).toBe('4.5000');
  });

  it('rounds to 4 decimals', () => {
    expect(outputUnitCost([d('10.00')], d('3')).toFixed(4)).toBe('3.3333');
  });
});
