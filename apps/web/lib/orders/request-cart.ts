import { type RequestAvailability, stockQuantitySchema } from '@durby/shared';

/**
 * The branch's request cart (ADR 0053): items and quantities picked like a shopping basket, then sent as one stock
 * request. Pure: the page renders and changes it; a copy is kept in the browser per organization and branch.
 */

/** Item id → quantity as typed ("2", "1.5"). */
export type Cart = Readonly<Record<string, string>>;

export const OTHER_CATEGORY = '';

/** "1,5" → "1.5"; trims. */
const clean = (value: string) => value.trim().replace(',', '.');

/** A quantity the api takes: above 0, up to 3 decimals. */
export const validQuantity = (value: string) => {
  const q = clean(value);
  return stockQuantitySchema.safeParse(q).success && Number(q) > 0;
};

/** Thousandths ("2.5" → 2500n), exact (CLAUDE.md rule 6); null when not a quantity. */
function thousandths(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(clean(value));
  if (!match) return null;
  const digits = BigInt(`${match[2]}${(match[3] ?? '').padEnd(3, '0')}`);
  return match[1] ? -digits : digits;
}

/** 2500n → "2.5". */
function plain(value: bigint): string {
  const fraction = String(value % 1000n)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return fraction ? `${value / 1000n}.${fraction}` : String(value / 1000n);
}

/** What the warehouse has, in thousandths; below zero counts as none. */
const most = (available: string) => {
  const there = thousandths(available) ?? 0n;
  return there < 0n ? 0n : there;
};

/** Within what the warehouse has: a branch can't ask for 4 when 2 are there. */
export const withinStock = (quantity: string, available: string) => {
  const q = thousandths(quantity);
  return q !== null && q <= most(available);
};

/**
 * Whether one more fits (the "+" button): below what the warehouse has; by the box (`step` pieces, ADR 0065) only a
 * whole box.
 */
export const canAddMore = (quantity: string | undefined, available: string, step = 1) => {
  const current = thousandths(quantity ?? '0') ?? 0n;
  return step > 1 ? current + BigInt(step) * 1000n <= most(available) : current < most(available);
};

/** Pieces in a box (ADR 0065): items counted in pieces with a pack count above 1; null for the others. */
export function piecesPerBox(item: { unit: string; packCount: number | null }): number | null {
  return item.unit === 'pc' && item.packCount !== null && item.packCount > 1
    ? item.packCount
    : null;
}

/** Pieces as boxes ("24" with 12 a box → "2"; "18" → "1.5"). */
export function boxesOf(quantity: string, perBox: number): string {
  const pieces = thousandths(quantity) ?? 0n;
  return plain((pieces + BigInt(perBox) / 2n) / BigInt(perBox));
}

/** Boxes typed as pieces ("2" with 12 a box → "24"); null when not a quantity. */
export function piecesOf(boxes: string, perBox: number): string | null {
  const value = thousandths(boxes);
  return value === null || value < 0n ? null : plain(value * BigInt(perBox));
}

/** Box or piece per item (ADR 0065): item id → how it is ordered; items with boxes default to the box. */
export type CartUnits = Readonly<Record<string, 'box' | 'piece'>>;

export const unitsStorageKey = (organizationId: string, locationId: string) =>
  `request-cart-units:${organizationId}:${locationId}`;

export function parseStoredUnits(text: string | null): CartUnits {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (e): e is [string, 'box' | 'piece'] => e[1] === 'box' || e[1] === 'piece',
      ),
    );
  } catch {
    return {};
  }
}

/** What the warehouse has, as the page shows it ("2.000" → "2"; below zero "0"). */
export const availableText = (available: string) => plain(most(available));

/**
 * One more (whole steps; "1.5" becomes "2.5"), never beyond what the warehouse has: below a whole step it goes to the
 * limit, at the limit nothing changes. Without `available` there is no limit.
 */
export function increment(cart: Cart, itemId: string, available?: string, step = 1): Cart {
  const current = thousandths(cart[itemId] ?? '0') ?? 0n;
  let next = (current < 0n ? 0n : current) + BigInt(step) * 1000n;
  if (available !== undefined) {
    const limit = most(available);
    if (current >= limit) return cart;
    // By the box only whole boxes; otherwise up to what is there.
    if (next > limit) {
      if (step > 1) return cart;
      next = limit;
    }
  }
  return { ...cart, [itemId]: plain(next) };
}

/** Lines asking for more than the warehouse has (they block sending). */
export const beyondStock = (lines: ReturnType<typeof cartLines>) =>
  lines.filter((l) => validQuantity(l.quantity) && !withinStock(l.quantity, l.item.available));

/** One less; at 1 or below the item leaves the cart. */
export function decrement(cart: Cart, itemId: string, step = 1): Cart {
  const current = Number(clean(cart[itemId] ?? '0'));
  if (!Number.isFinite(current) || current <= step) return remove(cart, itemId);
  return { ...cart, [itemId]: trim(current - step) };
}

/** As typed; an empty field keeps the line (the person is still typing), "0" removes it. */
export function setQuantity(cart: Cart, itemId: string, value: string): Cart {
  if (clean(value) !== '' && Number(clean(value)) === 0) return remove(cart, itemId);
  return { ...cart, [itemId]: value };
}

export function remove(cart: Cart, itemId: string): Cart {
  const { [itemId]: _gone, ...rest } = cart;
  void _gone;
  return rest;
}

/** Lines still offered (items that disappeared from the warehouse's list are dropped). */
export function cartLines(cart: Cart, items: readonly RequestAvailability[]) {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  return Object.entries(cart).flatMap(([itemId, quantity]) => {
    const item = byId.get(itemId);
    return item ? [{ item, quantity }] : [];
  });
}

/** Every line has a quantity the api takes, within what the warehouse has. */
export const cartReady = (lines: ReturnType<typeof cartLines>) =>
  lines.length > 0 &&
  lines.every((l) => validQuantity(l.quantity) && withinStock(l.quantity, l.item.available));

/** The request's lines, in cart order. */
export const requestLines = (lines: ReturnType<typeof cartLines>) =>
  lines.map((l) => ({ itemId: l.item.itemId, quantity: clean(l.quantity) }));

/** The categories of the offered items, by name, "Other" (no category) last; with how many items each has. */
export function categoriesOf(items: readonly RequestAvailability[]) {
  const counts = new Map<string, { id: string; name: string | null; count: number }>();
  for (const item of items) {
    const id = item.categoryId ?? OTHER_CATEGORY;
    const entry = counts.get(id) ?? { id, name: item.categoryName, count: 0 };
    entry.count += 1;
    counts.set(id, entry);
  }
  return [...counts.values()].sort(
    (a, b) =>
      Number(a.id === OTHER_CATEGORY) - Number(b.id === OTHER_CATEGORY) ||
      (a.name ?? '').localeCompare(b.name ?? ''),
  );
}

/** Items of a category (null: all) whose name or SKU contains the search, in stock first, then by name. */
export function shownItems(
  items: readonly RequestAvailability[],
  category: string | null,
  search: string,
): RequestAvailability[] {
  const needle = search.trim().toLowerCase();
  return items
    .filter((i) => category === null || (i.categoryId ?? OTHER_CATEGORY) === category)
    .filter(
      (i) =>
        needle === '' ||
        i.itemName.toLowerCase().includes(needle) ||
        (i.sku ?? '').toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        Number(Number(a.available) <= 0) - Number(Number(b.available) <= 0) ||
        a.itemName.localeCompare(b.itemName),
    );
}

/** The browser's copy of a cart: per organization and branch; anything unreadable is an empty cart. */
export const cartStorageKey = (organizationId: string, locationId: string) =>
  `request-cart:${organizationId}:${locationId}`;

export function parseStoredCart(text: string | null): Cart {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && /^[0-9a-f-]{36}$/.test(e[0]),
      ),
    );
  } catch {
    return {};
  }
}

const trim = (n: number) => String(Math.round(n * 1000) / 1000);
