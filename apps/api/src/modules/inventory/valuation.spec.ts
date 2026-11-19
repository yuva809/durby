import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { bookIn, bookOut, costText, type Level, quantityText, valueOf } from './valuation';

const level = (quantity: string, averageCost: string, expiresOn: string | null = null): Level => ({
  quantity: new Decimal(quantity),
  averageCost: new Decimal(averageCost),
  expiresOn,
});
const text = (l: Level) => [quantityText(l.quantity), costText(l.averageCost)];

describe('weighted average valuation (ADR 0027)', () => {
  it('takes the cost of the first delivery', () => {
    const { level: after, unitCost } = bookIn(
      level('0', '0'),
      new Decimal('10'),
      new Decimal('2.5'),
    );
    expect(text(after)).toEqual(['10.000', '2.5000']);
    expect(costText(unitCost)).toBe('2.5000');
  });

  it('averages a second delivery at another price by quantity', () => {
    // 10 kg at 2.50 + 5 kg at 4.00 = 45.00 for 15 kg → 3.0000
    const { level: after } = bookIn(level('10', '2.5'), new Decimal('5'), new Decimal('4'));
    expect(text(after)).toEqual(['15.000', '3.0000']);
  });

  it('rounds the average to 4 decimals, half up', () => {
    // 2 at 1.00 + 1 at 2.00 = 4.00 for 3 → 1.3333…
    const { level: after } = bookIn(level('2', '1'), new Decimal('1'), new Decimal('2'));
    expect(costText(after.averageCost)).toBe('1.3333');
  });

  it('starts over from the incoming cost when the level was negative', () => {
    const { level: after } = bookIn(level('-2', '5'), new Decimal('10'), new Decimal('3'));
    expect(text(after)).toEqual(['8.000', '3.0000']);
  });

  it('takes stock out at the average and keeps it', () => {
    const { level: after, unitCost } = bookOut(level('15', '3'), new Decimal('4.5'));
    expect(text(after)).toEqual(['10.500', '3.0000']);
    expect(costText(unitCost)).toBe('3.0000');
    expect(valueOf(new Decimal('-4.5'), unitCost).toFixed(2)).toBe('-13.50');
  });

  it('rounds values to cents, half up', () => {
    expect(valueOf(new Decimal('0.333'), new Decimal('1.5')).toFixed(2)).toBe('0.50');
    expect(valueOf(new Decimal('1.005'), new Decimal('1')).toFixed(2)).toBe('1.01');
  });
});

describe('expiry dates (ADR 0062)', () => {
  it('keeps the earliest date of what is there, and drops it when nothing is left', () => {
    // 10 until 1 May; 5 more until 31 March: the earlier date.
    const first = bookIn(level('0', '0'), new Decimal(10), new Decimal('2'), '2027-05-01');
    expect(first.level.expiresOn).toBe('2027-05-01');
    const second = bookIn(first.level, new Decimal(5), new Decimal('2'), '2027-03-31');
    expect(second.level.expiresOn).toBe('2027-03-31');
    // Goods without a date leave it as it is.
    expect(bookIn(second.level, new Decimal(1), new Decimal('2')).level.expiresOn).toBe(
      '2027-03-31',
    );
    // Going out, the goods carry it; with nothing left it goes.
    const out = bookOut(second.level, new Decimal(15));
    expect(out.expiresOn).toBe('2027-03-31');
    expect(out.level.expiresOn).toBeNull();
    expect(bookOut(second.level, new Decimal(3)).level.expiresOn).toBe('2027-03-31');
  });

  it('starts over once the stock ran out', () => {
    // A level at 0 with an old date never passes it on.
    const empty = level('0', '2', '2026-01-01');
    expect(bookIn(empty, new Decimal(4), new Decimal('2'), '2027-06-30').level.expiresOn).toBe(
      '2027-06-30',
    );
    expect(bookIn(empty, new Decimal(4), new Decimal('2')).level.expiresOn).toBeNull();
  });
});
