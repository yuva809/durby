import { z } from 'zod';

/** Request and response bodies of /api/v1/inventory (docs/modules/inventory.md, ADR 0027). */

export const INVENTORY_NAME_MAX_LENGTH = 100;
export const INVENTORY_NOTE_MAX_LENGTH = 500;
export const STOCK_DOCUMENT_MAX_LINES = 200;

/** Units of a stock item; fixed once the item has movements. */
export const STOCK_UNITS = ['kg', 'g', 'l', 'ml', 'pc'] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

export const STOCK_DOCUMENT_KINDS = ['receipt', 'adjustment', 'transfer'] as const;
export type StockDocumentKind = (typeof STOCK_DOCUMENT_KINDS)[number];

/** Why stock was adjusted. */
export const ADJUSTMENT_REASONS = ['waste', 'breakage', 'count', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

const name = z.string().trim().min(1).max(INVENTORY_NAME_MAX_LENGTH);
const sortOrder = z.int().min(0).max(1_000_000);
const note = z.string().trim().max(INVENTORY_NOTE_MAX_LENGTH);

/** Decimal strings (CLAUDE.md rule 6): quantities up to 3 decimals, unit costs up to 4. */
export const stockQuantitySchema = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,3})?$/, 'Invalid quantity')
  .refine((v) => /[1-9]/.test(v), 'Quantity must be positive');
export const signedStockQuantitySchema = z
  .string()
  .regex(/^-?\d{1,10}(\.\d{1,3})?$/, 'Invalid quantity')
  .refine((v) => /[1-9]/.test(v), 'Quantity must not be zero');
export const unitCostSchema = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'Invalid cost');

export const warehouseSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  sortOrder: z.int(),
  archivedAt: z.iso.datetime().nullable(),
});

export const createWarehouseRequestSchema = z.strictObject({
  locationId: z.uuid(),
  name,
  sortOrder: sortOrder.optional(),
});

export const updateWarehouseRequestSchema = z
  .strictObject({
    name: name.optional(),
    sortOrder: sortOrder.optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

export const listWarehousesQuerySchema = z.object({
  locationId: z.uuid().optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const stockItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  unit: z.enum(STOCK_UNITS),
  /** Reorder level, 3 decimals; null = none. */
  minQuantity: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});

export const createStockItemRequestSchema = z.strictObject({
  name,
  sku: z.string().trim().min(1).max(50).optional(),
  unit: z.enum(STOCK_UNITS),
  minQuantity: stockQuantitySchema.optional(),
});

export const updateStockItemRequestSchema = z
  .strictObject({
    name: name.optional(),
    sku: z.string().trim().min(1).max(50).nullable().optional(),
    unit: z.enum(STOCK_UNITS).optional(),
    minQuantity: stockQuantitySchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

export const listStockItemsQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/** An item at most once per document. */
const uniqueItems = <T extends { itemId: string }>(lines: T[]) =>
  new Set(lines.map((l) => l.itemId)).size === lines.length;

const lines = <T extends z.ZodType<{ itemId: string }>>(line: T) =>
  z
    .array(line)
    .min(1)
    .max(STOCK_DOCUMENT_MAX_LINES)
    .refine(uniqueItems, { message: 'An item can be on a document only once' });

export const receiptRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  supplier: z.string().trim().min(1).max(INVENTORY_NAME_MAX_LENGTH).optional(),
  note: note.optional(),
  lines: lines(
    z.strictObject({ itemId: z.uuid(), quantity: stockQuantitySchema, unitCost: unitCostSchema }),
  ),
});

export const adjustmentRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: note.optional(),
  lines: lines(z.strictObject({ itemId: z.uuid(), quantity: signedStockQuantitySchema })),
});

export const transferRequestSchema = z.strictObject({
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  note: note.optional(),
  lines: lines(z.strictObject({ itemId: z.uuid(), quantity: stockQuantitySchema })),
});

export const stockMovementSchema = z.object({
  id: z.uuid(),
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  itemName: z.string(),
  unit: z.enum(STOCK_UNITS),
  /** Signed, 3 decimals. */
  quantity: z.string(),
  /** 4 decimals. */
  unitCost: z.string(),
  /** Signed, 2 decimals. */
  value: z.string(),
});

export const stockDocumentSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  kind: z.enum(STOCK_DOCUMENT_KINDS),
  warehouseId: z.uuid(),
  warehouseName: z.string(),
  toWarehouseId: z.uuid().nullable(),
  toWarehouseName: z.string().nullable(),
  reason: z.enum(ADJUSTMENT_REASONS).nullable(),
  supplier: z.string().nullable(),
  note: z.string().nullable(),
  lineCount: z.int(),
  /** Sum of the line values in `warehouseId` (signed, 2 decimals). */
  value: z.string(),
  createdAt: z.iso.datetime(),
});

export const stockDocumentSchema = stockDocumentSummarySchema.extend({
  lines: z.array(stockMovementSchema),
});

export const listStockDocumentsQuerySchema = z.object({
  locationId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  kind: z.enum(STOCK_DOCUMENT_KINDS).optional(),
});

export const stockLevelSchema = z.object({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  itemName: z.string(),
  unit: z.enum(STOCK_UNITS),
  /** 3 decimals, may be negative when allowed. */
  quantity: z.string(),
  averageCost: z.string(),
  /** quantity × average cost, 2 decimals. */
  value: z.string(),
  /** At or below the item's reorder level. */
  low: z.boolean(),
});

export const stockQuerySchema = z.object({
  locationId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
});

export const warehouseListResponseSchema = z.object({ data: z.array(warehouseSchema) });
export const stockItemListResponseSchema = z.object({ data: z.array(stockItemSchema) });
export const stockLevelListResponseSchema = z.object({ data: z.array(stockLevelSchema) });
export const stockDocumentListResponseSchema = z.object({
  data: z.array(stockDocumentSummarySchema),
});

export type Warehouse = z.infer<typeof warehouseSchema>;
export type CreateWarehouseRequest = z.infer<typeof createWarehouseRequestSchema>;
export type UpdateWarehouseRequest = z.infer<typeof updateWarehouseRequestSchema>;
export type ListWarehousesQuery = z.infer<typeof listWarehousesQuerySchema>;
export type StockItem = z.infer<typeof stockItemSchema>;
export type CreateStockItemRequest = z.infer<typeof createStockItemRequestSchema>;
export type UpdateStockItemRequest = z.infer<typeof updateStockItemRequestSchema>;
export type ListStockItemsQuery = z.infer<typeof listStockItemsQuerySchema>;
export type ReceiptRequest = z.infer<typeof receiptRequestSchema>;
export type AdjustmentRequest = z.infer<typeof adjustmentRequestSchema>;
export type TransferRequest = z.infer<typeof transferRequestSchema>;
export type StockMovement = z.infer<typeof stockMovementSchema>;
export type StockDocumentSummary = z.infer<typeof stockDocumentSummarySchema>;
export type StockDocument = z.infer<typeof stockDocumentSchema>;
export type ListStockDocumentsQuery = z.infer<typeof listStockDocumentsQuerySchema>;
export type StockLevel = z.infer<typeof stockLevelSchema>;
export type StockQuery = z.infer<typeof stockQuerySchema>;

/** Stable error codes of the inventory endpoints; the web app shows the matching label. */
export const INVENTORY_ERROR_CODES = [
  'inventory.warehouse_not_found',
  'inventory.location_not_found',
  'inventory.item_not_found',
  'inventory.document_not_found',
  'inventory.warehouse_name_taken',
  'inventory.item_name_taken',
  'inventory.insufficient_stock',
  'inventory.unit_locked',
  'inventory.valuation_unsupported',
  'inventory.same_warehouse',
] as const;

export type InventoryErrorCode = (typeof INVENTORY_ERROR_CODES)[number];

/** `inventory.item_not_found` → `inventory.errors.itemNotFound`. */
export function inventoryErrorLabel(code: InventoryErrorCode): string {
  return `inventory.errors.${code.slice('inventory.'.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
