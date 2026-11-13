import { z } from 'zod';
import { ORDER_LINE_MAX_QUANTITY, orderBillSchema, orderTotalsSchema } from './pos-orders';

/**
 * Bills and guest checks (docs/modules/pos.md → Step 4, ADR 0036). A bill is one act of billing over 1–10 open
 * orders of one location; it prints one guest check, or one per share of an equal split. No payment, no receipt.
 */

export const BILL_MAX_ORDERS = 10;
export const BILL_MAX_ITEMS = 200;
export const BILL_MIN_SHARES = 2;
export const BILL_MAX_SHARES = 20;
export const BILL_CANCEL_REASON_MAX_LENGTH = 200;
export const CHECKS_PAGE_SIZE = 50;
/** `GET /pos/checks?view=recent`: checks of the last this many hours. */
export const RECENT_CHECKS_HOURS = 24;
export const CHECK_SEARCH_MAX_LENGTH = 32;

export const BILL_KINDS = ['single', 'equal'] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export const CHECK_VIEWS = ['recent', 'history'] as const;
/** What a check line is: a billed item, an order discount, or one share of an equal split per VAT rate. */
export const CHECK_LINE_KINDS = ['item', 'discount', 'share'] as const;

export const createBillRequestSchema = z
  .strictObject({
    orderIds: z
      .array(z.uuid())
      .min(1)
      .max(BILL_MAX_ORDERS)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'orderIds must be unique' }),
    /** Portions to bill; missing = everything unbilled on the orders. */
    items: z
      .array(
        z.strictObject({
          orderLineId: z.uuid(),
          quantity: z.int().min(1).max(ORDER_LINE_MAX_QUANTITY),
        }),
      )
      .min(1)
      .max(BILL_MAX_ITEMS)
      .refine((items) => new Set(items.map((i) => i.orderLineId)).size === items.length, {
        message: 'each orderLineId once',
      })
      .optional(),
    /** Split everything unbilled equally into this many guest checks (ADR 0036 §4). */
    shares: z.int().min(BILL_MIN_SHARES).max(BILL_MAX_SHARES).optional(),
  })
  .refine((body) => !(body.items && body.shares), {
    message: 'items and shares cannot be combined',
    path: ['shares'],
  });

export const cancelBillRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(BILL_CANCEL_REASON_MAX_LENGTH),
});

/** One line as the check prints it. */
export const checkLineSchema = z.object({
  kind: z.enum(CHECK_LINE_KINDS),
  /** Item: product name; discount: the reason; share: null. */
  name: z.string().nullable(),
  /** Items only. */
  quantity: z.int().nullable(),
  unitPrice: z.string().nullable(),
  taxRate: z.string(),
  /** Gross, two decimals; negative on a discount. */
  total: z.string(),
});

/** An order a check covers, for its header. */
export const checkOrderSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  tableId: z.uuid(),
  tableName: z.string(),
  covers: z.int().nullable(),
  /** Who opened the order (ADR 0025); null when the member is gone. */
  waiterName: z.string().nullable(),
});

export const guestCheckSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  billId: z.uuid(),
  locationId: z.uuid(),
  /** 1..n on a share of an equal split; null on a whole bill. */
  shareIndex: z.int().nullable(),
  shareCount: z.int().nullable(),
  createdAt: z.iso.datetime(),
  cancelled: z.boolean(),
  cancelledAt: z.iso.datetime().nullable(),
  orders: z.array(checkOrderSchema),
  lines: z.array(checkLineSchema),
  totals: orderTotalsSchema,
});

export const billSchema = orderBillSchema.extend({
  locationId: z.uuid(),
  orderIds: z.array(z.uuid()),
  /** Gross of the whole bill (all shares). */
  gross: z.string(),
});

export const checkSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  billId: z.uuid(),
  locationId: z.uuid(),
  shareIndex: z.int().nullable(),
  shareCount: z.int().nullable(),
  gross: z.string(),
  createdAt: z.iso.datetime(),
  cancelled: z.boolean(),
  tableNames: z.array(z.string()),
  orderNumbers: z.array(z.string()),
});

const date = z.iso.date();

export const listChecksQuerySchema = z.object({
  locationId: z.uuid().optional(),
  view: z.enum(CHECK_VIEWS).default('recent'),
  /** History only: first and last day, inclusive (UTC days). */
  from: date.optional(),
  to: date.optional(),
  /** History only: part of a check number. */
  q: z.string().trim().min(1).max(CHECK_SEARCH_MAX_LENGTH).optional(),
  /** The previous page's `nextCursor`. */
  cursor: z.uuid().optional(),
});

export const checkListResponseSchema = z.object({
  data: z.array(checkSummarySchema),
  nextCursor: z.uuid().nullable(),
});

export type CreateBillRequest = z.infer<typeof createBillRequestSchema>;
export type CancelBillRequest = z.infer<typeof cancelBillRequestSchema>;
export type CheckLine = z.infer<typeof checkLineSchema>;
export type CheckOrder = z.infer<typeof checkOrderSchema>;
export type GuestCheck = z.infer<typeof guestCheckSchema>;
export type Bill = z.infer<typeof billSchema>;
export type CheckSummary = z.infer<typeof checkSummarySchema>;
export type ListChecksQuery = z.infer<typeof listChecksQuerySchema>;
export type CheckListResponse = z.infer<typeof checkListResponseSchema>;
