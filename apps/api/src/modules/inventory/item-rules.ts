import Decimal from 'decimal.js';

/**
 * Pure rules of the inventory sub-modules (docs/modules/inventory.md → Step 5, ADR 0038): unit conversion, variant
 * combinations and production quantities. Quantities have 3 decimals, costs 4 (rounded half up), like valuation.ts.
 */

const QUANTITY_PLACES = 3;
const COST_PLACES = 4;

const quantity3 = (value: Decimal) => value.toDecimalPlaces(QUANTITY_PLACES, Decimal.ROUND_HALF_UP);
const cost4 = (value: Decimal) => value.toDecimalPlaces(COST_PLACES, Decimal.ROUND_HALF_UP);

/**
 * A receipt line entered in a unit of `factor` base units: the quantity in base units and the cost per base unit.
 * Null when the converted quantity rounds to zero (a line must move something).
 */
export function toBaseUnits(
  quantity: Decimal,
  unitCost: Decimal,
  factor: Decimal,
): { quantity: Decimal; unitCost: Decimal } | null {
  const base = quantity3(quantity.times(factor));
  if (base.isZero()) return null;
  return { quantity: base, unitCost: cost4(unitCost.dividedBy(factor)) };
}

/** Every combination of one value per list, in list order: [[S, L], [x]] → [[S, x], [L, x]]. */
export function combinations(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>(
    (acc, values) => acc.flatMap((prefix) => values.map((value) => [...prefix, value])),
    [[]],
  );
}

/** Stock item names are at most 100 characters (stock_items_name_check). */
const NAME_MAX = 100;

/** A variant's name: the parent's, then its values (`Cola · 0.5 l`); the parent's part is shortened to fit. */
export function variantName(parentName: string, values: readonly string[]): string {
  const suffix = ` · ${values.join(' / ')}`;
  const room = Math.max(1, NAME_MAX - suffix.length);
  const parent = parentName.length > room ? parentName.slice(0, room).trimEnd() : parentName;
  return `${parent}${suffix}`.slice(0, NAME_MAX).trim();
}

/**
 * What making `wanted` of an item takes: each component's bill quantity × wanted ÷ the bill's output quantity,
 * rounded to 3 decimals. Components that round to zero are left out (nothing to move).
 */
export function componentNeeds(
  bill: { outputQuantity: Decimal; lines: readonly { itemId: string; quantity: Decimal }[] },
  wanted: Decimal,
): { itemId: string; quantity: Decimal }[] {
  const scale = wanted.dividedBy(bill.outputQuantity);
  return bill.lines
    .map((line) => ({ itemId: line.itemId, quantity: quantity3(line.quantity.times(scale)) }))
    .filter((line) => !line.quantity.isZero());
}

/** The made item's cost per unit: what its components were worth (to cents each) ÷ the quantity made. */
export function outputUnitCost(componentValues: readonly Decimal[], made: Decimal): Decimal {
  const total = componentValues.reduce((sum, value) => sum.plus(value), new Decimal(0));
  return cost4(total.dividedBy(made));
}
