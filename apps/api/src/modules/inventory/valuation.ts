import Decimal from 'decimal.js';

/**
 * Weighted average valuation per warehouse and item (docs/modules/inventory.md, ADR 0027 §5).
 * Quantities have 3 decimals, costs 4, values 2 (rounded half up). Pure: the service locks the
 * levels and writes what these return.
 */

export interface Level {
  quantity: Decimal;
  averageCost: Decimal;
}

export interface Booked {
  level: Level;
  /** The movement's unit cost. */
  unitCost: Decimal;
}

const COST_PLACES = 4;

export const quantityText = (value: Decimal) => value.toFixed(3);
export const costText = (value: Decimal) =>
  value.toDecimalPlaces(COST_PLACES, Decimal.ROUND_HALF_UP).toFixed(COST_PLACES);
/** quantity × unit cost, to cents. */
export function valueOf(quantity: Decimal, unitCost: Decimal): Decimal {
  return quantity.times(unitCost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Stock coming in at `unitCost`: the average moves towards it by quantity. With nothing (or a
 * negative level) on hand the incoming cost becomes the average.
 */
export function bookIn(level: Level, quantity: Decimal, unitCost: Decimal): Booked {
  const after = level.quantity.plus(quantity);
  const averageCost =
    level.quantity.lte(0) || after.lte(0)
      ? unitCost
      : level.quantity.times(level.averageCost).plus(quantity.times(unitCost)).dividedBy(after);
  return {
    level: {
      quantity: after,
      averageCost: averageCost.toDecimalPlaces(COST_PLACES, Decimal.ROUND_HALF_UP),
    },
    unitCost: unitCost.toDecimalPlaces(COST_PLACES, Decimal.ROUND_HALF_UP),
  };
}

/** Stock going out (a positive `quantity`) at the current average; the average stays. */
export function bookOut(level: Level, quantity: Decimal): Booked {
  return {
    level: { quantity: level.quantity.minus(quantity), averageCost: level.averageCost },
    unitCost: level.averageCost,
  };
}
