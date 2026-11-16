import { z } from 'zod';
import { priceSchema } from './catalog';
import { STOCK_UNITS, stockQuantitySchema } from './inventory';

/**
 * Request and response bodies of /api/v1/orders (docs/modules/orders.md, ADR 0044): the customers and sales orders of
 * a distribution business. Order lines sell stock items; money and quantities are decimal strings (CLAUDE.md rule 6).
 * Names are prefixed (`orderCustomer…`, `salesOrder…`): the staff portal's "customers" are organizations.
 */

export const ORDER_CUSTOMER_NAME_MAX_LENGTH = 120;
export const ORDER_CUSTOMER_CODE_MAX_LENGTH = 30;
export const ORDER_TEXT_MAX_LENGTH = 500;
export const SALES_ORDER_MAX_LINES = 200;
export const SALES_ORDER_LIST_MAX = 200;

/**
 * A sales order's life (ADR 0044 §3). Draft orders can be edited; confirmed ones wait for picking; `cancelled` is
 * possible until dispatch. Picking, packing and delivery arrive with step 3.
 */
export const SALES_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'picking',
  'packed',
  'dispatched',
  'delivered',
  'cancelled',
] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

/** Statuses an order can still be cancelled from. */
export const SALES_ORDER_CANCELLABLE: readonly SalesOrderStatus[] = [
  'draft',
  'confirmed',
  'picking',
  'packed',
];

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max);
/** `YYYY-MM-DD`, a calendar day (the requested delivery day). */
export const calendarDaySchema = z.iso.date();

// ---------------------------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------------------------

export const orderCustomerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The business's own reference, unique among active customers; null = none. */
  code: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  note: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});

export const createOrderCustomerRequestSchema = z.strictObject({
  name: text(ORDER_CUSTOMER_NAME_MAX_LENGTH),
  code: text(ORDER_CUSTOMER_CODE_MAX_LENGTH).optional(),
  phone: text(40).optional(),
  email: z.email().max(254).optional(),
  address: text(ORDER_TEXT_MAX_LENGTH).optional(),
  note: text(ORDER_TEXT_MAX_LENGTH).optional(),
});

export const updateOrderCustomerRequestSchema = z
  .strictObject({
    name: text(ORDER_CUSTOMER_NAME_MAX_LENGTH).optional(),
    code: text(ORDER_CUSTOMER_CODE_MAX_LENGTH).nullable().optional(),
    phone: text(40).nullable().optional(),
    email: z.email().max(254).nullable().optional(),
    address: text(ORDER_TEXT_MAX_LENGTH).nullable().optional(),
    note: text(ORDER_TEXT_MAX_LENGTH).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

export const listOrderCustomersQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const orderCustomerListResponseSchema = z.object({ data: z.array(orderCustomerSchema) });

export type OrderCustomer = z.infer<typeof orderCustomerSchema>;
export type CreateOrderCustomerRequest = z.infer<typeof createOrderCustomerRequestSchema>;
export type UpdateOrderCustomerRequest = z.infer<typeof updateOrderCustomerRequestSchema>;
export type ListOrderCustomersQuery = z.infer<typeof listOrderCustomersQuerySchema>;

// ---------------------------------------------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------------------------------------------

export const salesOrderLineRequestSchema = z.strictObject({
  itemId: z.uuid(),
  quantity: stockQuantitySchema,
  /** Per unit of the item, 2 decimals; filled from the item's sale price in the web. */
  unitPrice: priceSchema,
});

const orderLines = z
  .array(salesOrderLineRequestSchema)
  .min(1)
  .max(SALES_ORDER_MAX_LINES)
  .refine((lines) => new Set(lines.map((l) => l.itemId)).size === lines.length, {
    message: 'Each item once',
  });

export const createSalesOrderRequestSchema = z.strictObject({
  customerId: z.uuid(),
  /** Where the goods leave from; the order's branch is the warehouse's location. */
  warehouseId: z.uuid(),
  lines: orderLines,
  requestedDate: calendarDaySchema.optional(),
  deliveryAddress: text(ORDER_TEXT_MAX_LENGTH).optional(),
  note: text(ORDER_TEXT_MAX_LENGTH).optional(),
  /** true: confirmed at once (no draft step). */
  confirm: z.boolean().optional(),
});

/** Only while the order is a draft; lines are replaced as a whole. */
export const updateSalesOrderRequestSchema = z
  .strictObject({
    customerId: z.uuid().optional(),
    warehouseId: z.uuid().optional(),
    lines: orderLines.optional(),
    requestedDate: calendarDaySchema.nullable().optional(),
    deliveryAddress: text(ORDER_TEXT_MAX_LENGTH).nullable().optional(),
    note: text(ORDER_TEXT_MAX_LENGTH).nullable().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

export const cancelSalesOrderRequestSchema = z.strictObject({
  reason: optionalText(ORDER_TEXT_MAX_LENGTH).optional(),
});

/** `?status=a` arrives as a string, `?status=a&status=b` as an array. */
const statuses = z.preprocess(
  (value) => (typeof value === 'string' ? [value] : value),
  z.array(z.enum(SALES_ORDER_STATUSES)).min(1).max(SALES_ORDER_STATUSES.length),
);

export const listSalesOrdersQuerySchema = z.object({
  status: statuses.optional(),
  locationId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  /** Inclusive lower bound on created_at. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Exclusive upper bound on created_at. */
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(SALES_ORDER_LIST_MAX).default(50),
  /** Opaque; `meta.nextCursor` of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
});

export const salesOrderLineSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  itemName: z.string(),
  unit: z.enum(STOCK_UNITS),
  /** 3 decimals. */
  quantity: z.string(),
  /** 2 decimals. */
  unitPrice: z.string(),
  /** quantity × unit price, rounded half up to cents. */
  lineTotal: z.string(),
});

export const salesOrderEventSchema = z.object({
  id: z.uuid(),
  status: z.enum(SALES_ORDER_STATUSES),
  /** Free text with the change (a cancel reason); null = none. */
  note: z.string().nullable(),
  userId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const salesOrderSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  status: z.enum(SALES_ORDER_STATUSES),
  customerId: z.uuid(),
  customerName: z.string(),
  locationId: z.uuid(),
  locationName: z.string(),
  warehouseId: z.uuid(),
  warehouseName: z.string(),
  requestedDate: calendarDaySchema.nullable(),
  lineCount: z.int(),
  /** Sum of the line totals, 2 decimals. */
  total: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const salesOrderSchema = salesOrderSummarySchema.extend({
  deliveryAddress: z.string().nullable(),
  note: z.string().nullable(),
  lines: z.array(salesOrderLineSchema),
  /** Oldest first. */
  events: z.array(salesOrderEventSchema),
});

export const salesOrderListResponseSchema = z.object({
  data: z.array(salesOrderSummarySchema),
  meta: z.object({ nextCursor: z.string().nullable(), limit: z.int() }),
});

export type SalesOrderLineRequest = z.infer<typeof salesOrderLineRequestSchema>;
export type CreateSalesOrderRequest = z.infer<typeof createSalesOrderRequestSchema>;
export type UpdateSalesOrderRequest = z.infer<typeof updateSalesOrderRequestSchema>;
export type CancelSalesOrderRequest = z.infer<typeof cancelSalesOrderRequestSchema>;
export type ListSalesOrdersQuery = z.infer<typeof listSalesOrdersQuerySchema>;
export type SalesOrderLine = z.infer<typeof salesOrderLineSchema>;
export type SalesOrderEvent = z.infer<typeof salesOrderEventSchema>;
export type SalesOrderSummary = z.infer<typeof salesOrderSummarySchema>;
export type SalesOrder = z.infer<typeof salesOrderSchema>;
export type SalesOrderListResponse = z.infer<typeof salesOrderListResponseSchema>;

/** Stable error codes of the orders endpoints; the web app shows the matching label. */
export const ORDERS_ERROR_CODES = [
  'orders.customer_not_found',
  'orders.customer_code_taken',
  'orders.order_not_found',
  'orders.warehouse_not_found',
  'orders.item_not_found',
  'orders.not_editable',
  'orders.invalid_transition',
] as const;

export type OrdersErrorCode = (typeof ORDERS_ERROR_CODES)[number];
