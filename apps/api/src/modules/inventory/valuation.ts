import Decimal from 'decimal.js';

/**
 * Weighted average valuation per warehouse and item (docs/modules/inventory.md, ADR 0027 §5).
 * Quantities have 3 decimals, costs 4, values 2 (rounded half up). Pure: the service locks the
 * levels and writes what these return.
 */

export interface Level {
  quantity: Decimal;
  averageCost: Decimal;
  /** The earliest expiry date of what is in stock, "2027-03-31" (ADR 0062); null when unknown or none left. */
  expiresOn: string | null;
}

export interface Booked {
  level: Level;
  /** The movement's unit cost. */
  unitCost: Decimal;
  /** The expiry date the moved goods carry: given for goods coming in, the level's for goods going out. */
  expiresOn: string | null;
}

/** The earlier of two dates ("YYYY-MM-DD" compare as text), ignoring nulls. */
export function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
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
 * negative level) on hand the incoming cost becomes the average. Its expiry date (ADR 0062): the earlier of what is
 * there and `expiresOn`; goods without a date leave the date as it is.
 */
export function bookIn(
  level: Level,
  quantity: Decimal,
  unitCost: Decimal,
  expiresOn: string | null = null,
): Booked {
  const after = level.quantity.plus(quantity);
  const averageCost =
    level.quantity.lte(0) || after.lte(0)
      ? unitCost
      : level.quantity.times(level.averageCost).plus(quantity.times(unitCost)).dividedBy(after);
  const held = level.quantity.greaterThan(0) ? level.expiresOn : null;
  return {
    level: {
      quantity: after,
      averageCost: averageCost.toDecimalPlaces(COST_PLACES, Decimal.ROUND_HALF_UP),
      expiresOn: after.greaterThan(0) ? earliest(held, expiresOn) : null,
    },
    unitCost: unitCost.toDecimalPlaces(COST_PLACES, Decimal.ROUND_HALF_UP),
    expiresOn,
  };
}

/**
 * Stock going out (a positive `quantity`) at the current average; the average stays. The goods carry the level's
 * expiry date; with nothing left the date goes (ADR 0062).
 */
export function bookOut(level: Level, quantity: Decimal): Booked {
  const after = level.quantity.minus(quantity);
  return {
    level: {
      quantity: after,
      averageCost: level.averageCost,
      expiresOn: after.greaterThan(0) ? level.expiresOn : null,
    },
    unitCost: level.averageCost,
    expiresOn: level.expiresOn,
  };
}
