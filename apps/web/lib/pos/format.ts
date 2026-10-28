import type { Order } from '@durby/shared';

/**
 * Display helpers of the POS screens (docs/modules/pos.md → Web). Money stays a decimal string
 * (CLAUDE.md rule 6): sums use integer cents, and Intl formats the string itself.
 */

/** `"12.50"` → 1250n. Accepts the api's two-decimal strings, also negative ones. */
export function toCents(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

/** 1250n → `"12.50"`. */
export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** Price × quantity as a decimal string. */
export function times(price: string, quantity: number): string {
  return fromCents(toCents(price) * BigInt(quantity));
}

/** Sum of decimal strings. */
export function sum(values: readonly string[]): string {
  return fromCents(values.reduce((total, v) => total + toCents(v), 0n));
}

/** A VAT rate without trailing zeros: `"7.00"` → `"7"`, `"5.50"` → `"5.5"`. */
export function rate(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** Whole minutes from `since` to `now`, never negative. */
export function minutesSince(since: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
}

/** The label of a duration: `{ key, values }` for `t()`, e.g. "18 h 11 min" or "35 min". */
export function durationLabel(minutes: number): {
  key: 'pos.time.minutes' | 'pos.time.hoursMinutes';
  values: Record<string, string>;
} {
  if (minutes < 60) return { key: 'pos.time.minutes', values: { minutes: String(minutes) } };
  return {
    key: 'pos.time.hoursMinutes',
    values: { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) },
  };
}

export type MoneyFormat = (amount: string) => string;

/**
 * A formatter for the organization's currency and locale. `Intl.NumberFormat` formats the decimal
 * string exactly (no float conversion); an unknown currency falls back to the plain string.
 */
export function moneyFormat(locale: string, currency: string): MoneyFormat {
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
    return (amount) => format.format(amount as `${number}`);
  } catch {
    return (amount) => amount;
  }
}

/** One line of the bill: the same product, price and note combined across tickets. */
export interface BillLine {
  key: string;
  name: string;
  note: string | null;
  quantity: number;
  unitPrice: string;
  total: string;
}

/**
 * The order as a bill (docs/modules/pos.md → Web): what is left of every sent item, combined by
 * product, unit price and note in the order they were first sent; fully voided items are dropped.
 */
export function billLines(order: Pick<Order, 'tickets'>): BillLine[] {
  const lines = new Map<string, BillLine>();
  for (const ticket of order.tickets) {
    for (const line of ticket.lines) {
      if (line.quantity <= 0 || line.remaining === 0) continue;
      const key = `${line.productId}|${line.unitPrice}|${line.note ?? ''}`;
      const current = lines.get(key);
      const quantity = (current?.quantity ?? 0) + line.remaining;
      lines.set(key, {
        key,
        name: line.productName,
        note: line.note,
        quantity,
        unitPrice: line.unitPrice,
        total: times(line.unitPrice, quantity),
      });
    }
  }
  return [...lines.values()];
}
