import { z } from 'zod';

/**
 * Discounts and comps on an order (docs/modules/pos.md → Step 4b, ADR 0036 §5). One discount per line or per
 * order; a discounted line is billed whole. A comp is a 100 % discount on a line.
 */

export const DISCOUNT_KINDS = ['percent', 'amount'] as const;
export const DISCOUNT_REASON_MAX_LENGTH = 40;

export const addDiscountRequestSchema = z.strictObject({
  /** Missing: the whole order (spread over the lines still to bill). */
  orderLineId: z.uuid().optional(),
  kind: z.enum(DISCOUNT_KINDS),
  /** Decimal string: percent 0 < v <= 100, amount > 0 (at most what is left to bill). */
  value: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
  reason: z.string().trim().min(1).max(DISCOUNT_REASON_MAX_LENGTH),
});

export const discountSchema = z.object({
  id: z.uuid(),
  orderLineId: z.uuid().nullable(),
  kind: z.enum(DISCOUNT_KINDS),
  value: z.string(),
  reason: z.string(),
  /** Negative gross, two decimals: what the discount takes off the items still to bill. */
  amount: z.string(),
  /** Removed by a later row. */
  voided: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type AddDiscountRequest = z.infer<typeof addDiscountRequestSchema>;
export type Discount = z.infer<typeof discountSchema>;
