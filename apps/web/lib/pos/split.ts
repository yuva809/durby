/**
 * The split dialog's previews (docs/modules/pos.md → Step 4c–4e, ADR 0036): exact cents with BigInt, never JS
 * numbers for money (CLAUDE.md rule 6). The api computes the real checks; these only show what the guest is about to
 * pay.
 */

/** "12.40" → 1240n; anything else → 0n. */
export function centsOf(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return 0n;
  const [, sign, whole, fraction = ''] = match;
  const cents = BigInt(`${whole}${fraction.padEnd(2, '0')}`);
  return sign === '-' ? -cents : cents;
}

/** 1240n → "12.40". */
export function centsText(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** How many portions and what they cost: Σ count × unit price, for the lines picked so far. */
export function pickedTotal(
  lines: readonly { id: string; unitPrice: string }[],
  counts: Readonly<Record<string, number>>,
): { items: number; gross: string } {
  let items = 0;
  let cents = 0n;
  for (const line of lines) {
    const count = counts[line.id] ?? 0;
    if (count <= 0) continue;
    items += count;
    cents += centsOf(line.unitPrice) * BigInt(count);
  }
  return { items, gross: centsText(cents) };
}

/**
 * About what each guest pays when `total` is split `shares` ways: the even part, and whether some pay a cent more
 * (the api gives left-over cents to the first checks, per VAT rate).
 */
export function equalShare(total: string, shares: number): { each: string; uneven: boolean } {
  const cents = centsOf(total);
  const n = BigInt(Math.max(1, shares));
  return { each: centsText(cents / n), uneven: cents % n !== 0n };
}

/** The sum of decimal money strings. */
export function sumMoney(values: readonly string[]): string {
  return centsText(values.reduce((sum, value) => sum + centsOf(value), 0n));
}
