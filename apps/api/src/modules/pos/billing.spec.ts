import { describe, expect, it } from 'vitest';
import { billedByLine, remainingOf, unbilledGross, unbilledOf } from './billing';

describe('billing quantities', () => {
  const lines = [
    { id: 'a', quantity: 3, voidsLineId: null },
    { id: 'b', quantity: 2, voidsLineId: null },
    { id: 'v', quantity: -1, voidsLineId: 'a' },
  ];

  it('takes voids off what was sent', () => {
    expect(remainingOf(lines)).toEqual(
      new Map([
        ['a', 2],
        ['b', 2],
      ]),
    );
  });

  it('adds up the portions of each line over bills', () => {
    expect(
      billedByLine([
        { orderLineId: 'a', quantity: 1 },
        { orderLineId: 'b', quantity: 2 },
        { orderLineId: 'a', quantity: 1 },
      ]),
    ).toEqual(
      new Map([
        ['a', 2],
        ['b', 2],
      ]),
    );
  });

  it('leaves what is not billed yet, never less than nothing', () => {
    const unbilled = unbilledOf(
      remainingOf(lines),
      new Map([
        ['a', 1],
        ['b', 5],
      ]),
    );
    expect(unbilled).toEqual(
      new Map([
        ['a', 1],
        ['b', 0],
      ]),
    );
  });

  it('prices the unbilled portions in cents', () => {
    expect(
      unbilledGross(
        [
          { id: 'a', unitPrice: '16.90' },
          { id: 'b', unitPrice: '4.50' },
        ],
        new Map([
          ['a', 2],
          ['b', 0],
        ]),
      ),
    ).toBe('33.80');
    expect(unbilledGross([{ id: 'a', unitPrice: '16.90' }], new Map())).toBe('0.00');
  });
});
