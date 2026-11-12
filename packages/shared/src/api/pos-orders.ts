import { z } from 'zod';
import { PREP_STATIONS } from './catalog';
import { TABLE_COLORS, TABLE_SHAPES } from './pos-tables';

/** Request and response bodies of the order endpoints (docs/modules/pos.md → Step 3). */

export const ORDER_NOTE_MAX_LENGTH = 200;
export const ORDER_LINE_MAX_QUANTITY = 99;
export const TICKET_MAX_LINES = 100;
/** Guests at the table (docs/modules/pos.md → Covers). */
export const ORDER_MAX_COVERS = 100;

export const POS_ORDER_STATUSES = ['open', 'closed'] as const;
export const KITCHEN_TICKET_KINDS = ['order', 'void'] as const;
/** A ticket's progress on the kitchen or bar screen (ADR 0026); `new` = no status change yet. */
export const TICKET_STATUSES = ['new', 'preparing', 'ready', 'served'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

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
  /** Portions of `remaining` on bills that are not cancelled (ADR 0036); 0 on void lines. */
  billedQuantity: z.int(),
  /** unitPrice × quantity, gross. */
  total: z.string(),
  createdAt: z.iso.datetime(),
});

export const kitchenTicketSchema = z.object({
  id: z.uuid(),
  sequence: z.int(),
  kind: z.enum(KITCHEN_TICKET_KINDS),
  /** Where it prints: kitchen or bar (ADR 0025). */
  station: z.enum(PREP_STATIONS),
  /** Its progress on the station's screen (ADR 0026). */
  status: z.enum(TICKET_STATUSES),
  /** Went straight to the bill: the station's processing was off (ADR 0031). */
  direct: z.boolean(),
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
  /** Tickets ready to serve: on the station's screen as ready, not yet served (ADR 0026). */
  readyCount: z.int(),
  /** Gross still to bill: items not on a bill that is not cancelled (ADR 0036). */
  unbilled: z.string(),
});

/** A guest check of a bill, as the order lists it (docs/modules/pos.md → Step 4). */
export const billCheckSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  /** 1..n on a share of an equal split; null on a whole bill. */
  shareIndex: z.int().nullable(),
  gross: z.string(),
});

/** A bill over this order (ADR 0036). */
export const orderBillSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['single', 'equal']),
  shareCount: z.int().nullable(),
  createdAt: z.iso.datetime(),
  cancelled: z.boolean(),
  checks: z.array(billCheckSchema),
});

export const orderSchema = orderSummarySchema.extend({
  tickets: z.array(kitchenTicketSchema),
  totals: orderTotalsSchema,
  /** Who opened the order, for the bill (ADR 0025); null when the member is gone. */
  waiterName: z.string().nullable(),
  /** Bills over this order, oldest first, cancelled ones included. */
  bills: z.array(orderBillSchema),
});

/**
 * One ticket per station the send (or void) had lines for, in sequence order (ADR 0025); `ticketId` is
 * the first, kept for older clients.
 */
export const sendTicketResponseSchema = z.object({
  order: orderSchema,
  ticketId: z.uuid(),
  ticketIds: z.array(z.uuid()).min(1),
  /**
   * The tickets queued on a printer of the location (ADR 0033): the till prints them, so the device that sent them
   * doesn't. Missing from older apis: nothing queued.
   */
  printQueuedIds: z.array(z.uuid()).optional(),
});

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

/** Whether each station prepares what is sent, at the table's location (ADR 0031). */
export const stationProcessingSchema = z.object({ kitchen: z.boolean(), bar: z.boolean() });

export const tableOrderResponseSchema = z.object({
  table: floorTableSchema.omit({ order: true }),
  order: orderSchema.nullable(),
  processing: stationProcessingSchema,
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
export type OrderBill = z.infer<typeof orderBillSchema>;
export type BillCheck = z.infer<typeof billCheckSchema>;
export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type Order = z.infer<typeof orderSchema>;
export type SendTicketResponse = z.infer<typeof sendTicketResponseSchema>;
export type FloorTable = z.infer<typeof floorTableSchema>;
export type FloorResponse = z.infer<typeof floorResponseSchema>;
export type StationProcessing = z.infer<typeof stationProcessingSchema>;
export type TableOrderResponse = z.infer<typeof tableOrderResponseSchema>;
export type FloorQuery = z.infer<typeof floorQuerySchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
export type OrderListResponse = z.infer<typeof orderListResponseSchema>;
