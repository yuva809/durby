import Decimal from 'decimal.js';

/**
 * Discount amounts per order line (docs/modules/pos.md → Step 4b, ADR 0036 §5). Pure: the rows come from the
 * services. Amounts are fixed when the discount is given, from the items still to bill; they are negative.
 */

export interface DiscountTarget {
  orderLineId: string;
  taxRate: string;
  /** Gross of the items still to bill on this line (unit price × unbilled quantity). */
  gross: string;
}

export interface LineDiscount {
  orderLineId: string;
  taxRate: string;
  /** Negative, two decimals. */
  amount: string;
}

const cents = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * The discount per line. `percent` takes the share of each line's gross, rounded per line. An `amount` on one line
 * is that amount; an `amount` on the whole order is spread pro rata over the lines, the cents left over going to the
 * lines with the largest remainders. Null when the discount doesn't fit (more than what is left, or nothing to take).
 */
export function allocateDiscount(
  targets: readonly DiscountTarget[],
  kind: 'percent' | 'amount',
  value: string,
  wholeOrder: boolean,
): LineDiscount[] | null {
  const open = targets.filter((t) => new Decimal(t.gross).greaterThan(0));
  const total = open.reduce((sum, t) => sum.plus(t.gross), new Decimal(0));
  if (open.length === 0 || total.isZero()) return null;
  const v = new Decimal(value);
  if (kind === 'percent') {
    if (v.lessThanOrEqualTo(0) || v.greaterThan(100)) return null;
    return open.map((t) => ({
      orderLineId: t.orderLineId,
      taxRate: t.taxRate,
      amount: cents(new Decimal(t.gross).times(v).dividedBy(100)).negated().toFixed(2),
    }));
  }
  if (v.lessThanOrEqualTo(0) || v.greaterThan(total)) return null;
  if (!wholeOrder) {
    const target = open[0]!;
    if (open.length !== 1 || v.greaterThan(target.gross)) return null;
    return [
      {
        orderLineId: target.orderLineId,
        taxRate: target.taxRate,
        amount: cents(v).negated().toFixed(2),
      },
    ];
  }
  // Pro rata in cents: floor each share, then hand the leftover cents to the largest remainders.
  const pool = cents(v).times(100).toNumber();
  const shares = open.map((t) => {
    const exact = new Decimal(t.gross).times(pool).dividedBy(total);
    return { t, floor: exact.floor().toNumber(), rest: exact.minus(exact.floor()).toNumber() };
  });
  let leftover = pool - shares.reduce((n, s) => n + s.floor, 0);
  const order = [...shares].sort((a, b) => b.rest - a.rest);
  for (const s of order) {
    if (leftover <= 0) break;
    s.floor += 1;
    leftover -= 1;
  }
  return shares.map((s) => ({
    orderLineId: s.t.orderLineId,
    taxRate: s.t.taxRate,
    amount: new Decimal(-s.floor).dividedBy(100).toFixed(2),
  }));
}
