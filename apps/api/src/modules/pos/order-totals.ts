import Decimal from 'decimal.js';
import type { OrderTotals } from '@durby/shared';

/** What totals need of a line: decimal strings and a signed portion count. */
export interface PricedLine {
  unitPrice: string;
  taxRate: string;
  quantity: number;
}

const cents = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** Gross unit price × quantity (negative for a void line), as a decimal string (rule 6). */
export function lineTotal(unitPrice: string, quantity: number): string {
  return cents(new Decimal(unitPrice).times(quantity));
}

/**
 * Gross total and the per-VAT-rate split of an order's lines (docs/modules/pos.md → Totals). Prices
 * are gross, so net = gross / (1 + rate / 100) and tax = gross − net, each rounded to cents. Rates
 * with nothing left after voids are dropped; rates come out in ascending order.
 */
export function orderTotals(lines: readonly PricedLine[]): OrderTotals {
  const byRate = new Map<string, { rate: Decimal; gross: Decimal; count: number }>();
  let gross = new Decimal(0);
  let itemCount = 0;
  for (const line of lines) {
    const rate = new Decimal(line.taxRate);
    const key = rate.toFixed(2);
    const amount = new Decimal(line.unitPrice).times(line.quantity);
    const entry = byRate.get(key) ?? { rate, gross: new Decimal(0), count: 0 };
    entry.gross = entry.gross.plus(amount);
    entry.count += line.quantity;
    byRate.set(key, entry);
    gross = gross.plus(amount);
    itemCount += line.quantity;
  }
  const byTaxRate = [...byRate.values()]
    .filter((entry) => entry.count !== 0)
    .sort((a, b) => a.rate.comparedTo(b.rate))
    .map(({ rate, gross: rateGross }) => {
      const net = rateGross
        .dividedBy(rate.dividedBy(100).plus(1))
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const roundedGross = rateGross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      return {
        taxRate: rate.toFixed(2),
        gross: roundedGross.toFixed(2),
        net: net.toFixed(2),
        tax: roundedGross.minus(net).toFixed(2),
      };
    });
  return { itemCount, gross: cents(gross), byTaxRate };
}
