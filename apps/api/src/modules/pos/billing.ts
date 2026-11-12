import Decimal from 'decimal.js';

/**
 * What is billed and what is left to bill (docs/modules/pos.md → Step 4, ADR 0036). Pure: the rows come from the
 * services. A line's billed quantity is the sum of its portions on bills that are not cancelled.
 */

/** A sent line (quantity > 0) or a void of one, as the order stores it. */
export interface LineQuantity {
  id: string;
  quantity: number;
  voidsLineId: string | null;
}

/** What is left of each sent line after its voids (void lines carry negative quantities). */
export function remainingOf(lines: readonly LineQuantity[]): Map<string, number> {
  const left = new Map<string, number>();
  for (const line of lines) if (line.quantity > 0) left.set(line.id, line.quantity);
  for (const line of lines) {
    if (line.voidsLineId)
      left.set(line.voidsLineId, (left.get(line.voidsLineId) ?? 0) + line.quantity);
  }
  return left;
}

/** Portions of each order line on bills that are not cancelled. */
export function billedByLine(
  items: readonly { orderLineId: string; quantity: number }[],
): Map<string, number> {
  const billed = new Map<string, number>();
  for (const item of items) {
    billed.set(item.orderLineId, (billed.get(item.orderLineId) ?? 0) + item.quantity);
  }
  return billed;
}

/** What is left to bill of each sent line: what is left after voids minus what is billed, never below 0. */
export function unbilledOf(
  remaining: ReadonlyMap<string, number>,
  billed: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [lineId, left] of remaining)
    out.set(lineId, Math.max(0, left - (billed.get(lineId) ?? 0)));
  return out;
}

/** Gross of the unbilled portions, two decimals (rule 6). */
export function unbilledGross(
  lines: readonly { id: string; unitPrice: string }[],
  unbilled: ReadonlyMap<string, number>,
): string {
  let gross = new Decimal(0);
  for (const line of lines) {
    const quantity = unbilled.get(line.id) ?? 0;
    if (quantity > 0) gross = gross.plus(new Decimal(line.unitPrice).times(quantity));
  }
  return gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
