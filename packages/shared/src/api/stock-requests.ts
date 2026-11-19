import { z } from 'zod';
import { pickedQuantitySchema } from './orders';
import { STOCK_UNITS, stockQuantitySchema } from './inventory';

/**
 * Branch stock requests (docs/modules/orders.md → Branch requests, ADR 0045): a branch asks a warehouse for goods
 * (SRQ-…), an owner or admin approves (it becomes transfer TRF-…) or rejects, the warehouse picks and packs (goods move
 * into "In transit"), a driver picks up and delivers, the branch confirms what arrived (goods move into the branch).
 */

export const STOCK_REQUEST_STATUSES = [
  'submitted',
  'approved',
  'picking',
  'packed',
  'in_transit',
  'delivered',
  'received',
  'rejected',
  'cancelled',
] as const;
export type StockRequestStatus = (typeof STOCK_REQUEST_STATUSES)[number];

/** Waiting for the warehouse: approved and being picked. */
export const STOCK_REQUEST_TO_PICK: readonly StockRequestStatus[] = ['approved', 'picking'];
/** On its way: packed, picked up, handed over (the branch can confirm from in transit on). */
export const STOCK_REQUEST_ON_THE_WAY: readonly StockRequestStatus[] = [
  'packed',
  'in_transit',
  'delivered',
];
export const STOCK_REQUEST_DONE: readonly StockRequestStatus[] = [
  'received',
  'rejected',
  'cancelled',
];

export const STOCK_REQUEST_MAX_LINES = 200;
export const STOCK_REQUEST_NOTE_MAX_LENGTH = 500;

const note = z.string().trim().min(1).max(STOCK_REQUEST_NOTE_MAX_LENGTH);
const lineQuantities = z
  .array(z.strictObject({ lineId: z.uuid(), quantity: pickedQuantitySchema }))
  .min(1)
  .max(STOCK_REQUEST_MAX_LINES)
  .refine((lines) => new Set(lines.map((l) => l.lineId)).size === lines.length, {
    message: 'Each line once',
  });

export const createStockRequestSchema = z
  .strictObject({
    /** Absent: the main warehouse (ADR 0053); with a main warehouse, only it. */
    fromWarehouseId: z.uuid().optional(),
    /** A warehouse at the branch, or `toLocationId`: the branch, whose store is created on its first request. */
    toWarehouseId: z.uuid().optional(),
    toLocationId: z.uuid().optional(),
    lines: z
      .array(z.strictObject({ itemId: z.uuid(), quantity: stockQuantitySchema }))
      .min(1)
      .max(STOCK_REQUEST_MAX_LINES)
      .refine((lines) => new Set(lines.map((l) => l.itemId)).size === lines.length, {
        message: 'Each item once',
      }),
    note: note.optional(),
  })
  .refine((body) => (body.toWarehouseId === undefined) !== (body.toLocationId === undefined), {
    message: 'Either toWarehouseId or toLocationId',
    path: ['toWarehouseId'],
  });

/** Approve: the quantity to send per line (0 drops it; at least one above 0). */
export const approveStockRequestSchema = z.strictObject({
  lines: lineQuantities,
  note: note.optional(),
});

export const stockRequestNoteSchema = z.strictObject({ note: note.optional() });

/** Pack: what was picked per line (at most what was approved), and optionally the driver. */
export const packStockRequestSchema = z.strictObject({
  lines: lineQuantities,
  driverUserId: z.uuid().optional(),
});

export const assignDriverSchema = z.strictObject({ driverUserId: z.uuid() });

/** Receive: what arrived per line (at most what was packed); the rest is booked as short. */
export const receiveStockRequestSchema = z.strictObject({
  lines: lineQuantities,
  note: note.optional(),
});

const statuses = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(',') : value),
  z.array(z.enum(STOCK_REQUEST_STATUSES)).min(1).max(STOCK_REQUEST_STATUSES.length),
);

export const listStockRequestsQuerySchema = z.object({
  status: statuses.optional(),
  /** Only those assigned to the caller as driver. */
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const stockRequestLineSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  itemName: z.string(),
  unit: z.enum(STOCK_UNITS),
  /** 3 decimals each; null until that step. */
  quantity: z.string(),
  approvedQuantity: z.string().nullable(),
  pickedQuantity: z.string().nullable(),
  receivedQuantity: z.string().nullable(),
});

export const stockRequestEventSchema = z.object({
  id: z.uuid(),
  status: z.enum(STOCK_REQUEST_STATUSES),
  note: z.string().nullable(),
  userId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const stockRequestSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  /** Set on approval. */
  transferNumber: z.string().nullable(),
  status: z.enum(STOCK_REQUEST_STATUSES),
  fromWarehouseId: z.uuid(),
  fromWarehouseName: z.string(),
  fromLocationName: z.string(),
  toWarehouseId: z.uuid(),
  toWarehouseName: z.string(),
  /** The branch. */
  locationId: z.uuid(),
  locationName: z.string(),
  lineCount: z.int(),
  driverUserId: z.uuid().nullable(),
  driverName: z.string().nullable(),
  /** Who sent the request (ADR 0059): the Order History's "Requested by". Default for older apis. */
  requestedByName: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const stockRequestSchema = stockRequestSummarySchema.extend({
  note: z.string().nullable(),
  /** The branch's and the source location's address, for the documents (ADR 0064); defaults for older apis. */
  locationAddress: z.string().nullable().default(null),
  fromLocationAddress: z.string().nullable().default(null),
  lines: z.array(stockRequestLineSchema),
  /** Oldest first. */
  events: z.array(stockRequestEventSchema),
});

export const stockRequestListResponseSchema = z.object({
  data: z.array(stockRequestSummarySchema),
});

/** Warehouses a request can name: every active one, and whether the caller can request into it. */
export const requestWarehouseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  locationId: z.uuid(),
  locationName: z.string(),
  /** The caller may request goods for this warehouse (its branch). */
  canRequestInto: z.boolean(),
  /** Supplies every branch (ADR 0053). Default for older apis. */
  isMain: z.boolean().default(false),
});

/**
 * A branch the caller may request goods for (ADR 0053), with the warehouse goods go into: its own, or null when it
 * has none yet (the first request creates its store).
 */
export const requestDestinationSchema = z.object({
  locationId: z.uuid(),
  locationName: z.string(),
  warehouseId: z.uuid().nullable(),
  warehouseName: z.string().nullable(),
});
export const requestDestinationListResponseSchema = z.object({
  data: z.array(requestDestinationSchema),
});
export const requestWarehouseListResponseSchema = z.object({
  data: z.array(requestWarehouseSchema),
});

/** What a source warehouse has, for the request form (no costs). */
export const requestAvailabilitySchema = z.object({
  /** The earliest expiry date of what the warehouse holds (ADR 0062); default for older apis. */
  expiresOn: z.string().nullable().default(null),
  itemId: z.uuid(),
  itemName: z.string(),
  sku: z.string().nullable(),
  unit: z.enum(STOCK_UNITS),
  /** 3 decimals; may be 0. */
  available: z.string(),
  /** For grouping the request cart (ADR 0053). Defaults for older apis. */
  categoryId: z.uuid().nullable().default(null),
  categoryName: z.string().nullable().default(null),
});
export const requestAvailabilityResponseSchema = z.object({
  data: z.array(requestAvailabilitySchema),
});

/** Who can drive for a warehouse. */
export const requestDriverSchema = z.object({ userId: z.uuid(), name: z.string() });
export const requestDriverListResponseSchema = z.object({ data: z.array(requestDriverSchema) });

export type CreateStockRequest = z.infer<typeof createStockRequestSchema>;
export type ApproveStockRequest = z.infer<typeof approveStockRequestSchema>;
export type StockRequestNote = z.infer<typeof stockRequestNoteSchema>;
export type PackStockRequest = z.infer<typeof packStockRequestSchema>;
export type AssignDriver = z.infer<typeof assignDriverSchema>;
export type ReceiveStockRequest = z.infer<typeof receiveStockRequestSchema>;
export type ListStockRequestsQuery = z.infer<typeof listStockRequestsQuerySchema>;
export type StockRequestLine = z.infer<typeof stockRequestLineSchema>;
export type StockRequestSummary = z.infer<typeof stockRequestSummarySchema>;
export type StockRequest = z.infer<typeof stockRequestSchema>;
export type RequestWarehouse = z.infer<typeof requestWarehouseSchema>;
export type RequestAvailability = z.infer<typeof requestAvailabilitySchema>;
export type RequestDestination = z.infer<typeof requestDestinationSchema>;
export type RequestDriver = z.infer<typeof requestDriverSchema>;

export const STOCK_REQUEST_ERROR_CODES = [
  'orders.request_not_found',
  'orders.request_invalid',
  'orders.request_main_only',
  'orders.request_above_stock',
  'orders.request_branch_only',
  'orders.request_transition',
  'orders.request_not_yours',
  'orders.driver_not_found',
] as const;
export type StockRequestErrorCode = (typeof STOCK_REQUEST_ERROR_CODES)[number];
