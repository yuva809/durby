import Decimal from 'decimal.js';
import { METRIC_KEYS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { addSales, changePercent, METRIC, NO_SALES, percent, salesFigures } from './metrics';

const sales = { gross: new Decimal('100.10'), items: 9, orders: 3, secondRoundOrders: 1 };
const tables = { orders: 2, seconds: 2 * 45 * 60 + 60, open: 4 };
const reservations = {
  covers: 10,
  walkInCovers: 2,
  kept: 3,
  noShows: 1,
  turns: 2,
  turnSeconds: 3 * 60 * 60,
};

describe('metrics (ADR 0081)', () => {
  it('has exactly one function per registered metric', () => {
    expect(Object.keys(METRIC).sort()).toEqual([...METRIC_KEYS].sort());
  });

  it('works out each figure', () => {
    expect(salesFigures(sales)).toEqual({
      gross: '100.10',
      items: 9,
      orders: 3,
      averageOrder: '33.37',
    });
    expect(METRIC['sales.secondRoundRate']({ sales })).toBe('33.3');
    expect(METRIC['tables.averageMinutes']({ tables })).toBe(46);
    expect(METRIC['tables.open']({ tables })).toBe(4);
    expect(METRIC['reservations.covers']({ reservations })).toBe(10);
    expect(METRIC['reservations.noShowRate']({ reservations })).toBe('25.0');
    expect(METRIC['reservations.turnMinutes']({ reservations })).toBe(90);
  });

  it('has no average or rate of nothing', () => {
    expect(salesFigures(NO_SALES)).toEqual({
      gross: '0.00',
      items: 0,
      orders: 0,
      averageOrder: null,
    });
    expect(METRIC['sales.secondRoundRate']({ sales: NO_SALES })).toBeNull();
    expect(
      METRIC['tables.averageMinutes']({ tables: { orders: 0, seconds: 0, open: 0 } }),
    ).toBeNull();
    const none = { covers: 0, walkInCovers: 0, kept: 0, noShows: 0, turns: 0, turnSeconds: 0 };
    expect(METRIC['reservations.noShowRate']({ reservations: none })).toBeNull();
    expect(METRIC['reservations.turnMinutes']({ reservations: none })).toBeNull();
    expect(percent(1, 0)).toBeNull();
  });

  it('adds money exactly and compares only with something', () => {
    const cents = { ...NO_SALES, gross: new Decimal('0.10') };
    expect(addSales([cents, cents, cents]).gross.toFixed(2)).toBe('0.30');
    expect(changePercent(new Decimal(150), new Decimal(100))).toBe('50.0');
    expect(changePercent(new Decimal(0), new Decimal(80))).toBe('-100.0');
    expect(changePercent(new Decimal(10), new Decimal(0))).toBeNull();
  });
});
