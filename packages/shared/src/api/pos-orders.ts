import { z } from 'zod';
import { TABLE_COLORS, TABLE_SHAPES } from './pos-tables';

/** Request and response bodies of the order endpoints (docs/modules/pos.md → Step 3). */

export const ORDER_NOTE_MAX_LENGTH = 200;
export const ORDER_LINE_MAX_QUANTITY = 99;
export const TICKET_MAX_LINES = 100;
/** Guests at the table (docs/modules/pos.md → Covers). */
export const ORDER_MAX_COVERS = 100;

export const POS_ORDER_STATUSES = ['open', 'closed'] as const;
export const KITCHEN_TICKET_KINDS = ['order', 'void'] as const;

const quantity = z.int().min(1).max(ORDER_LINE_MAX_QUANTITY);
const covers = z.int().min(1).max(ORDER_MAX_COVERS);

export const sendTicketRequestSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        quantity,
        /** Empty means none. */
        note: z.string().trim().max(ORDER_NOTE_MAX_LENGTH).optional(),
      }),
    )
    .min(1)
    .max(TICKET_MAX_LINES),
  /** Guests at the table, used only when this send opens the order (else ignored; see PATCH). */
  covers: covers.optional(),
});

/** `PATCH /pos/orders/:id`: `null` clears the covers. */
export const updateOrderRequestSchema = z.strictObject({ covers: covers.nullable() });

export const voidLinesRequestSchema = z.strictObject({
  lines: z
    .array(z.strictObject({ lineId: z.uuid(), quantity }))
    .min(1)
    .max(TICKET_MAX_LINES),
});

export const orderLineSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  productId: z.uuid(),
  /** Snapshot taken when the line was sent. */
  productName: z.string(),
  /** Gross, two decimals. */
  unitPrice: z.string(),
  taxRate: z.string(),
  /** Negative on a void line. */
  quantity: z.int(),
  note: z.string().nullable(),
  /** Set on void lines: the line they cancel. */
  voidsLineId: z.uuid().nullable(),
  /** What is left of a sent line after voids; 0 on void lines. */
  remaining: z.int(),
  /** unitPrice × quantity, gross. */
  total: z.string(),
  createdAt: z.iso.datetime(),
});

export const kitchenTicketSchema = z.object({
  id: z.uuid(),
  sequence: z.int(),
  kind: z.enum(KITCHEN_TICKET_KINDS),
  createdAt: z.iso.datetime(),
  lines: z.array(orderLineSchema),
});

export const taxBreakdownSchema = z.object({
  taxRate: z.string(),
  gross: z.string(),
  net: z.string(),
  tax: z.string(),
});

export const orderTotalsSchema = z.object({
  /** Items still on the order (sent minus voided). */
  itemCount: z.int(),
  gross: z.string(),
  byTaxRate: z.array(taxBreakdownSchema),
});

export const orderSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  tableId: z.uuid(),
  tableName: z.string(),
  locationId: z.uuid(),
  status: z.enum(POS_ORDER_STATUSES),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** Guests at the table, or null when not recorded. */
  covers: z.int().nullable(),
  itemCount: z.int(),
  gross: z.string(),
});

export const orderSchema = orderSummarySchema.extend({
  tickets: z.array(kitchenTicketSchema),
  totals: orderTotalsSchema,
});

export const sendTicketResponseSchema = z.object({ order: orderSchema, ticketId: z.uuid() });

export const floorTableSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  seats: z.int(),
  area: z.string().nullable(),
  shape: z.enum(TABLE_SHAPES),
  color: z.enum(TABLE_COLORS),
  /** The table's open order, or null when it is free. */
  order: orderSummarySchema.nullable(),
});

export const floorResponseSchema = z.object({ data: z.array(floorTableSchema) });

export const tableOrderResponseSchema = z.object({
  table: floorTableSchema.omit({ order: true }),
  order: orderSchema.nullable(),
});

export const floorQuerySchema = z.object({ locationId: z.uuid().optional() });

export const listOrdersQuerySchema = z.object({
  locationId: z.uuid().optional(),
  status: z.enum(POS_ORDER_STATUSES).optional(),
});

export const orderListResponseSchema = z.object({ data: z.array(orderSummarySchema) });

export type SendTicketRequest = z.infer<typeof sendTicketRequestSchema>;
export type VoidLinesRequest = z.infer<typeof voidLinesRequestSchema>;
export type UpdateOrderRequest = z.infer<typeof updateOrderRequestSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type KitchenTicket = z.infer<typeof kitchenTicketSchema>;
export type OrderTotals = z.infer<typeof orderTotalsSchema>;
export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type Order = z.infer<typeof orderSchema>;
export type SendTicketResponse = z.infer<typeof sendTicketResponseSchema>;
export type FloorTable = z.infer<typeof floorTableSchema>;
export type FloorResponse = z.infer<typeof floorResponseSchema>;
export type TableOrderResponse = z.infer<typeof tableOrderResponseSchema>;
export type FloorQuery = z.infer<typeof floorQuerySchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
export type OrderListResponse = z.infer<typeof orderListResponseSchema>;
