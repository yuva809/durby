import { signedStockQuantitySchema, stockQuantitySchema, unitCostSchema } from '@durby/shared';

/**
 * Exact decimal math for the inventory forms' previews (CLAUDE.md rule 6: never JS numbers for
 * stock or money): quantities have 3 decimals, costs 4, values 2. The api computes the booked
 * values itself; these only show what the user is about to book.
 */

/** A decimal string as an integer scaled by 10^places, or null when it isn't one. */
function scaled(value: string, places: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > places) return null;
  const digits = BigInt(`${whole}${fraction.padEnd(places, '0')}`);
  return sign === '-' ? -digits : digits;
}

/** Cents as a decimal string, e.g. -1350n → "-13.50". */
function centsText(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** Divides and rounds half away from zero. */
function divRound(value: bigint, by: bigint): bigint {
  const half = by / 2n;
  return value >= 0n ? (value + half) / by : -((-value + half) / by);
}

/** quantity × unit cost to cents, or null when either isn't a valid entry. */
export function lineValue(quantity: string, unitCost: string): string | null {
  const q = scaled(quantity, 3);
  const c = scaled(unitCost, 4);
  if (q === null || c === null) return null;
  // q·10³ × c·10⁴ = value·10⁷ → cents = value·10²
  return centsText(divRound(q * c, 100_000n));
}

/**
 * Whether two totals differ only by rounding unit costs to 4 decimals (ADR 0058): a price per piece worked out from a
 * pack's (101.50 for 400 pieces is 0.25375, kept as 0.2538) moves its line by at most half a cent plus half a
 * ten-thousandth per unit. Only lines whose cost has 3 or 4 decimals count; false when the totals are equal or either
 * isn't an amount.
 */
export function differsByRounding(
  total: string,
  printed: string,
  lines: readonly { quantity: string; unitCost: string }[],
): boolean {
  const a = scaled(total, 2);
  const b = scaled(printed, 2);
  if (a === null || b === null || a === b) return false;
  // Per line, in cents: ⌊0.5 + quantity × 0.005⌋, the quantity in thousandths.
  const allowance = lines
    .filter((l) => /\.\d{3,4}$/.test(l.unitCost.trim()))
    .reduce((cents, l) => cents + (500_000n + (scaled(l.quantity, 3) ?? 0n) * 5n) / 1_000_000n, 0n);
  return (a > b ? a - b : b - a) <= allowance;
}

/** The sum of decimal strings with 2 decimals. */
export function sumValues(values: readonly string[]): string {
  return centsText(values.reduce((sum, v) => sum + (scaled(v, 2) ?? 0n), 0n));
}

export const isQuantity = (value: string) => stockQuantitySchema.safeParse(value.trim()).success;
export const isSignedQuantity = (value: string) =>
  signedStockQuantitySchema.safeParse(value.trim()).success;
export const isUnitCost = (value: string) => unitCostSchema.safeParse(value.trim()).success;

/** Thousandths as a decimal string with 3 decimals, e.g. -1500n → "-1.500". */
function thousandthsText(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = `${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`;
  return negative ? `-${text}` : text;
}

/**
 * A bill's component quantity for making `wanted` (ADR 0038): quantity × wanted ÷ output quantity, 3 decimals,
 * rounded half up like the api. Null when an entry isn't a valid quantity.
 */
export function scaledQuantity(quantity: string, wanted: string, output: string): string | null {
  const q = scaled(quantity, 3);
  const w = scaled(wanted, 3);
  const o = scaled(output, 3);
  if (q === null || w === null || o === null || o === 0n) return null;
  // q·10³ × w·10³ ÷ o·10³ = result·10³
  return thousandthsText(divRound(q * w, o));
}

/** Compares two quantities (3 decimals): negative, zero or positive like a sort comparator. */
export function compareQuantities(a: string, b: string): number {
  const x = scaled(a, 3) ?? 0n;
  const y = scaled(b, 3) ?? 0n;
  return x === y ? 0 : x < y ? -1 : 1;
}

/** "10.500" → "10.5", "3.000" → "3": quantities as people write them. */
export function shortQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
