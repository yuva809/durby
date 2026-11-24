import Decimal from 'decimal.js';
import type { MetricKey, SalesFigures } from '@durby/shared';

/** What the fact tables answer for a span, before any metric is worked out. */
export interface SalesSums {
  gross: Decimal;
  items: number;
  orders: number;
  secondRoundOrders: number;
}

export interface TableSums {
  orders: number;
  seconds: number;
  open: number;
}

export interface ReservationSums {
  covers: number;
  walkInCovers: number;
  kept: number;
  noShows: number;
  turns: number;
  turnSeconds: number;
}

export interface MetricSums {
  sales: SalesSums;
  tables: TableSums;
  reservations: ReservationSums;
}

export const NO_SALES: SalesSums = {
  gross: new Decimal(0),
  items: 0,
  orders: 0,
  secondRoundOrders: 0,
};

/** `part` of `whole` in percent, one decimal; null when there is no whole. */
export function percent(part: Decimal.Value, whole: Decimal.Value): string | null {
  const total = new Decimal(whole);
  return total.isZero() ? null : new Decimal(part).times(100).dividedBy(total).toFixed(1);
}

const minutes = (seconds: number, count: number): number | null =>
  count === 0 ? null : Math.round(seconds / 60 / count);

/**
 * The one definition of each metric (docs/modules/reports.md → Metrics): every response takes its figures from here.
 * Typed by the registry: a metric without a function doesn't compile.
 */
export const METRIC = {
  'sales.gross': ({ sales }: Pick<MetricSums, 'sales'>) => sales.gross.toFixed(2),
  'sales.items': ({ sales }: Pick<MetricSums, 'sales'>) => sales.items,
  'sales.orders': ({ sales }: Pick<MetricSums, 'sales'>) => sales.orders,
  'sales.averageOrder': ({ sales }: Pick<MetricSums, 'sales'>) =>
    sales.orders === 0 ? null : sales.gross.dividedBy(sales.orders).toFixed(2),
  'sales.secondRoundRate': ({ sales }: Pick<MetricSums, 'sales'>) =>
    percent(sales.secondRoundOrders, sales.orders),
  'tables.averageMinutes': ({ tables }: Pick<MetricSums, 'tables'>) =>
    minutes(tables.seconds, tables.orders),
  'tables.open': ({ tables }: Pick<MetricSums, 'tables'>) => tables.open,
  'reservations.covers': ({ reservations }: Pick<MetricSums, 'reservations'>) =>
    reservations.covers,
  'reservations.noShowRate': ({ reservations: r }: Pick<MetricSums, 'reservations'>) =>
    percent(r.noShows, r.noShows + r.kept),
  'reservations.turnMinutes': ({ reservations: r }: Pick<MetricSums, 'reservations'>) =>
    minutes(r.turnSeconds, r.turns),
} as const satisfies Record<MetricKey, (sums: MetricSums) => string | number | null>;

export function salesFigures(sales: SalesSums): SalesFigures {
  return {
    gross: METRIC['sales.gross']({ sales }),
    items: METRIC['sales.items']({ sales }),
    orders: METRIC['sales.orders']({ sales }),
    averageOrder: METRIC['sales.averageOrder']({ sales }),
  };
}

export function addSales(rows: Iterable<SalesSums>): SalesSums {
  let sum = NO_SALES;
  for (const row of rows) {
    sum = {
      gross: sum.gross.plus(row.gross),
      items: sum.items + row.items,
      orders: sum.orders + row.orders,
      secondRoundOrders: sum.secondRoundOrders + row.secondRoundOrders,
    };
  }
  return sum;
}

/** How much more (or less) `now` is than `before` in percent, one decimal; null when there is nothing before. */
export function changePercent(now: Decimal, before: Decimal): string | null {
  return before.greaterThan(0) ? percent(now.minus(before), before) : null;
}
