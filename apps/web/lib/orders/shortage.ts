/**
 * Picking a branch request against what is in stock (docs/modules/orders.md → Branch requests): which lines are short
 * and what to start with. Exact decimal math in thousandths (CLAUDE.md rule 6), quantities as the api writes them.
 */

/** "6.000" → 6000n, "-2.5" → -2500n; null when not a quantity with at most 3 decimals. */
function thousandths(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const digits = BigInt(`${match[2]}${(match[3] ?? '').padEnd(3, '0')}`);
  return match[1] ? -digits : digits;
}

/** 6000n → "6", 2500n → "2.5". */
function plain(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fraction = String(abs % 1000n)
    .padStart(3, '0')
    .replace(/0+$/, '');
  const text = fraction ? `${abs / 1000n}.${fraction}` : String(abs / 1000n);
  return negative ? `-${text}` : text;
}

/**
 * One approved line against the source warehouse's stock: start with the approved quantity, or with what is in stock
 * when that is less (never below 0); `short` is how much of the approved quantity isn't there (null: none, or the
 * stock is unknown).
 */
export function pickPlan(
  approved: string,
  inStock: string | null,
): { initial: string; short: string | null } {
  const wanted = thousandths(approved) ?? 0n;
  const stock = inStock === null ? null : thousandths(inStock);
  if (stock === null) return { initial: plain(wanted), short: null };
  const there = stock < 0n ? 0n : stock;
  if (there >= wanted) return { initial: plain(wanted), short: null };
  return { initial: plain(there), short: plain(wanted - there) };
}

/** Whether `quantity` is more than `inStock`; false when either isn't a quantity. */
export function exceedsStock(quantity: string, inStock: string): boolean {
  const q = thousandths(quantity);
  const stock = thousandths(inStock);
  return q !== null && stock !== null && q > (stock < 0n ? 0n : stock);
}

/** A stock quantity as the dialogs show it: "4.000" → "4", below zero → "0". */
export function shownStock(inStock: string): string {
  const stock = thousandths(inStock);
  return stock === null ? inStock : plain(stock < 0n ? 0n : stock);
}
