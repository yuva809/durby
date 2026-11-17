import type { GuestCheck, Order, OrderBill } from '@durby/shared';

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
  /** Order bills only (billLines): how many are not on a bill yet. */
  unbilled?: number;
  /** Order bills only: the sent lines behind this one, oldest first, with what is unbilled of each. */
  parts?: { orderLineId: string; unbilled: number }[];
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
      const unbilled = Math.max(0, line.remaining - line.billedQuantity);
      lines.set(key, {
        key,
        name: line.productName,
        note: line.note,
        quantity,
        unitPrice: line.unitPrice,
        total: times(line.unitPrice, quantity),
        unbilled: (current?.unbilled ?? 0) + unbilled,
        parts: [
          ...(current?.parts ?? []),
          ...(unbilled > 0 ? [{ orderLineId: line.id, unbilled }] : []),
        ],
      });
    }
  }
  return [...lines.values()];
}

/** How many of each bill line (by key) are picked for a bill of chosen items. */
export type BillPick = Readonly<Record<string, number>>;

/**
 * The picked items as the api's bill items (docs/modules/pos.md → Step 4c): each bill line's count is taken from its
 * sent lines oldest first, never more than is unbilled. Counts above what is left (the order changed) are capped.
 */
export function pickedBillItems(
  lines: readonly BillLine[],
  pick: BillPick,
): { orderLineId: string; quantity: number }[] {
  return lines.flatMap((line) => {
    let wanted = Math.min(pick[line.key] ?? 0, line.unbilled ?? 0);
    const items: { orderLineId: string; quantity: number }[] = [];
    for (const part of line.parts ?? []) {
      if (wanted <= 0) break;
      const quantity = Math.min(wanted, part.unbilled);
      items.push({ orderLineId: part.orderLineId, quantity });
      wanted -= quantity;
    }
    return items;
  });
}

/** Count and amount of what is picked, capped like pickedBillItems. */
export function pickedBillTotal(
  lines: readonly BillLine[],
  pick: BillPick,
): { items: number; gross: string } {
  const picked = lines.map((line) => ({
    line,
    count: Math.min(pick[line.key] ?? 0, line.unbilled ?? 0),
  }));
  return {
    items: picked.reduce((n, p) => n + p.count, 0),
    gross: sum(picked.filter((p) => p.count > 0).map((p) => times(p.line.unitPrice, p.count))),
  };
}

/**
 * A guest check as bill lines (docs/modules/pos.md → Step 4): its items combined by name and unit price, in the
 * order they were billed. Share checks and discounts come as lines of their own (labelled by the caller).
 */
export function checkLines(check: Pick<GuestCheck, 'lines'>): BillLine[] {
  const lines = new Map<string, BillLine>();
  check.lines.forEach((line, index) => {
    if (line.kind !== 'item') {
      const key = `${line.kind}|${index}`;
      lines.set(key, {
        key,
        name: line.name ?? '',
        note: null,
        quantity: 1,
        unitPrice: line.total,
        total: line.total,
      });
      return;
    }
    const key = `item|${line.name}|${line.unitPrice}`;
    const quantity = (lines.get(key)?.quantity ?? 0) + (line.quantity ?? 0);
    lines.set(key, {
      key,
      name: line.name ?? '',
      note: null,
      quantity,
      unitPrice: line.unitPrice ?? '0.00',
      total: times(line.unitPrice ?? '0.00', quantity),
    });
  });
  return [...lines.values()];
}

/** The checks to reprint for an order: those of its newest bill that is not cancelled (none: nothing billed). */
export function latestChecks(order: Pick<Order, 'bills'>): OrderBill['checks'] {
  const bill = [...order.bills].reverse().find((b) => !b.cancelled);
  return bill?.checks ?? [];
}
