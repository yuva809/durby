import { z } from 'zod';
import { priceSchema, taxRateSchema } from './catalog';

/**
 * Bulk actions on products and categories (docs/modules/catalog.md → Bulk actions): request and
 * response bodies, and the exact price change the api applies and the web previews.
 */

export const CATALOG_BULK_MAX_IDS = 500;

const ids = z.array(z.uuid()).min(1).max(CATALOG_BULK_MAX_IDS);
/** A signed amount or percent with up to two decimals, e.g. `-1.5`, `10`. */
const signedDecimal = z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Invalid amount');

export const PRICE_CHANGE_MODES = ['set', 'add', 'percent'] as const;
export type PriceChangeMode = (typeof PRICE_CHANGE_MODES)[number];

export const priceChangeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('set'), value: priceSchema }),
  z.object({ mode: z.literal('add'), value: signedDecimal }),
  z.object({ mode: z.literal('percent'), value: signedDecimal }),
]);
export type PriceChange = z.infer<typeof priceChangeSchema>;

export const productBulkActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('archive') }),
  z.object({ kind: z.literal('restore') }),
  z.object({ kind: z.literal('delete') }),
  z.object({ kind: z.literal('move'), categoryId: z.uuid() }),
  z.object({ kind: z.literal('vat'), taxRate: taxRateSchema }),
  z.object({ kind: z.literal('price') }).extend({ change: priceChangeSchema }),
]);

export const productBulkRequestSchema = z.strictObject({
  ids,
  action: productBulkActionSchema,
});

export const categoryBulkRequestSchema = z.strictObject({
  ids,
  action: z.enum(['archive', 'restore', 'delete']),
});

const kept = z.array(z.object({ id: z.uuid(), reason: z.literal('sold') }));

export const productBulkResponseSchema = z.object({
  updated: z.array(z.uuid()),
  deleted: z.array(z.uuid()),
  /** Not deleted because they were sold (archive them instead). */
  kept,
});

export const categoryBulkResponseSchema = productBulkResponseSchema.extend({
  /** Products deleted together with their categories. */
  productsDeleted: z.int(),
});

export type ProductBulkAction = z.infer<typeof productBulkActionSchema>;
export type ProductBulkRequest = z.infer<typeof productBulkRequestSchema>;
export type CategoryBulkRequest = z.infer<typeof categoryBulkRequestSchema>;
export type ProductBulkResponse = z.infer<typeof productBulkResponseSchema>;
export type CategoryBulkResponse = z.infer<typeof categoryBulkResponseSchema>;

/** The largest price the column holds (`numeric(12, 2)`, `priceSchema`: 10 digits before the point). */
const MAX_CENTS = 10n ** 12n - 1n;

/** `"12.5"` → 1250n; `"-3"` → -300n. Input already validated (at most two decimals). */
function toCents(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * A price after `change`, as decimal text with two places, or null when it would be below 0 or
 * too large. Exact on whole cents (rule 6: no JS number math); a percent change rounds half up
 * to the cent.
 */
export function newPrice(price: string, change: PriceChange): string | null {
  const cents = toCents(price);
  let next: bigint;
  if (change.mode === 'set') next = toCents(change.value);
  else if (change.mode === 'add') next = cents + toCents(change.value);
  else {
    // value is in percent with two decimals, so ×100 → basis points of a percent (1 % = 100).
    const factor = 10_000n + toCents(change.value);
    const scaled = cents * factor;
    next = scaled >= 0n ? (scaled + 5_000n) / 10_000n : -((-scaled + 5_000n) / 10_000n);
  }
  return next < 0n || next > MAX_CENTS ? null : fromCents(next);
}
