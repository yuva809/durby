import { z } from 'zod';
import { PREP_STATIONS, priceSchema } from './catalog';

/** Request and response bodies of /api/v1/inventory (docs/modules/inventory.md, ADR 0027). */

export const INVENTORY_NAME_MAX_LENGTH = 100;
export const INVENTORY_NOTE_MAX_LENGTH = 500;
export const STOCK_DOCUMENT_MAX_LINES = 200;

/** Units of a stock item; fixed once the item has movements. */
/** How stock is counted. Box, bucket, bag and packet for goods bought and counted that way (ADR 0062). */
export const STOCK_UNITS = ['kg', 'g', 'l', 'ml', 'pc', 'box', 'bucket', 'bag', 'packet'] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

export const STOCK_DOCUMENT_KINDS = [
  'receipt',
  'adjustment',
  'transfer',
  'consumption',
  'production',
  /** Goods out to a customer when a sales order is picked (ADR 0044). */
  'issue',
  /** Goods back in from a cancelled or returned sales order (ADR 0044). */
  'restock',
] as const;
export type StockDocumentKind = (typeof STOCK_DOCUMENT_KINDS)[number];

/** Why stock was adjusted. */
export const ADJUSTMENT_REASONS = ['waste', 'breakage', 'count', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

const name = z.string().trim().min(1).max(INVENTORY_NAME_MAX_LENGTH);

/**
 * An item's brand and pack size (ADR 0055): "12 x 500 g" is count 12, size 500, unit g; size and unit come together.
 * The count alone ("Pack of 6") or the size alone ("4 kg") is fine too.
 */
export const BRAND_MAX_LENGTH = 100;
export const PACK_COUNT_MAX = 100_000;
const brand = z.string().trim().min(1).max(BRAND_MAX_LENGTH);
const packCount = z.int().min(1).max(PACK_COUNT_MAX);
const packSize = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,3})?$/, 'Invalid size')
  .refine((v) => Number(v) > 0, 'Invalid size');
const packFields = {
  brand: brand.optional(),
  packCount: packCount.optional(),
  packSize: packSize.optional(),
  packUnit: z.enum(STOCK_UNITS).optional(),
};
const packTogether = (body: { packSize?: string | null; packUnit?: string | null }) =>
  (body.packSize === undefined || body.packSize === null) ===
  (body.packUnit === undefined || body.packUnit === null);
const PACK_TOGETHER = { message: 'A pack size needs its unit', path: ['packUnit'] };
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
  /** Sales of this station at the location take their stock from here (Step 2). */
  suppliesStation: z.enum(PREP_STATIONS).nullable(),
  /** Goods between warehouses (ADR 0045): created by the app, one per organization. Default for older apis. */
  isTransit: z.boolean().default(false),
  /** Supplies every branch (ADR 0053): branch requests always come from it. At most one active. */
  isMain: z.boolean().default(false),
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
    suppliesStation: z.enum(PREP_STATIONS).nullable().optional(),
    /** Make it the main warehouse (another one stops being it), or not (ADR 0053). */
    isMain: z.boolean().optional(),
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
  /**
   * A variant's parent item (ADR 0038); null for other items. Defaults keep the web working against an api from
   * before ADR 0038 during a deploy.
   */
  parentItemId: z.uuid().nullable().default(null),
  /** A variant's attribute values in attribute order, e.g. ["Large", "0.5 l"]; empty for other items. */
  variantValues: z.array(z.string()).default([]),
  /** Default unit price on sales orders (ADR 0044), 2 decimals; null = none. Default for older apis. */
  salePrice: z.string().nullable().default(null),
  /** Its category (ADR 0048), from the organization's one category list; null = uncategorized. */
  categoryId: z.uuid().nullable().default(null),
  /** Brand and pack size (ADR 0055); defaults for older apis. `packSize` 3 decimals. */
  brand: z.string().nullable().default(null),
  packCount: z.int().nullable().default(null),
  packSize: z.string().nullable().default(null),
  packUnit: z.enum(STOCK_UNITS).nullable().default(null),
  archivedAt: z.iso.datetime().nullable(),
});

export const createStockItemRequestSchema = z
  .strictObject({
    name,
    sku: z.string().trim().min(1).max(50).optional(),
    unit: z.enum(STOCK_UNITS),
    minQuantity: stockQuantitySchema.optional(),
    salePrice: priceSchema.optional(),
    categoryId: z.uuid().nullable().optional(),
    ...packFields,
  })
  .refine(packTogether, PACK_TOGETHER);

export const updateStockItemRequestSchema = z
  .strictObject({
    name: name.optional(),
    sku: z.string().trim().min(1).max(50).nullable().optional(),
    unit: z.enum(STOCK_UNITS).optional(),
    minQuantity: stockQuantitySchema.nullable().optional(),
    salePrice: priceSchema.nullable().optional(),
    /** null: uncategorized. */
    categoryId: z.uuid().nullable().optional(),
    /** null clears (ADR 0055); a size is given or cleared with its unit. */
    brand: brand.nullable().optional(),
    packCount: packCount.nullable().optional(),
    packSize: packSize.nullable().optional(),
    packUnit: z.enum(STOCK_UNITS).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  })
  .refine((body) => (body.packSize === undefined) === (body.packUnit === undefined), PACK_TOGETHER)
  .refine(
    (body) => body.packSize === undefined || (body.packSize === null) === (body.packUnit === null),
    PACK_TOGETHER,
  );

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

/** A best-before date, "2027-03-31" (ADR 0062). */
export const expiryDateSchema = z.iso.date();

export const receiptRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  supplier: z.string().trim().min(1).max(INVENTORY_NAME_MAX_LENGTH).optional(),
  note: note.optional(),
  lines: lines(
    z.strictObject({
      itemId: z.uuid(),
      /** In `unitId` when given (converted to the item's unit, ADR 0038), else in the item's unit. */
      quantity: stockQuantitySchema,
      /** Per `unitId` when given, else per the item's unit. */
      unitCost: unitCostSchema,
      unitId: z.uuid().optional(),
      /** Best before, as printed (ADR 0062): the warehouse keeps the earliest date of what it holds. */
      expiresOn: expiryDateSchema.optional(),
    }),
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

/**
 * A vendor invoice as a goods receipt (ADR 0049): each line an existing item or a new one (created in the same
 * transaction, its SKU the supplier's product id), with quantity and unit cost in the item's unit.
 */
const newInvoiceItemSchema = z
  .strictObject({
    name,
    sku: z.string().trim().min(1).max(50).optional(),
    unit: z.enum(STOCK_UNITS),
    categoryId: z.uuid().nullable().optional(),
    ...packFields,
  })
  .refine(packTogether, PACK_TOGETHER);

/** `unitId`: the unit the supplier invoices in (ADR 0055); quantity and cost are in it, converted to the item's. */
export const importReceiptLineSchema = z.union([
  z.strictObject({
    itemId: z.uuid(),
    quantity: stockQuantitySchema,
    unitCost: unitCostSchema,
    unitId: z.uuid().optional(),
    /** Best before (ADR 0062). */
    expiresOn: expiryDateSchema.optional(),
    /** Set on the item as it is received (ADR 0055): category (null clears), brand, pack size. */
    itemDetails: z
      .strictObject({
        categoryId: z.uuid().nullable().optional(),
        ...packFields,
      })
      .refine(packTogether, PACK_TOGETHER)
      .optional(),
  }),
  z.strictObject({
    newItem: newInvoiceItemSchema,
    quantity: stockQuantitySchema,
    unitCost: unitCostSchema,
    unitId: z.uuid().optional(),
    /** Best before (ADR 0062). */
    expiresOn: expiryDateSchema.optional(),
  }),
]);

export const importReceiptRequestSchema = z
  .strictObject({
    warehouseId: z.uuid(),
    supplier: z.string().trim().min(1).max(INVENTORY_NAME_MAX_LENGTH).optional(),
    /** e.g. "Order 108666 · 10-11-2026". */
    note: note.optional(),
    lines: z.array(importReceiptLineSchema).min(1).max(STOCK_DOCUMENT_MAX_LINES),
  })
  .refine(
    (body) => {
      const ids = body.lines.flatMap((l) => ('itemId' in l ? [l.itemId] : []));
      const names = body.lines.flatMap((l) => ('newItem' in l ? [l.newItem.name.trim()] : []));
      return new Set(ids).size === ids.length && new Set(names).size === names.length;
    },
    { message: 'An item can be on the invoice only once' },
  );

export type ImportReceiptLine = z.infer<typeof importReceiptLineSchema>;
export type ImportReceiptRequest = z.infer<typeof importReceiptRequestSchema>;

export const stockMovementSchema = z.object({
  id: z.uuid(),
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  itemName: z.string(),
  unit: z.enum(STOCK_UNITS),
  /** Signed, 3 decimals. */
  quantity: z.string(),
  /** 4 decimals; null without inventory.prices.read (ADR 0060). */
  unitCost: z.string().nullable(),
  /** Signed, 2 decimals; null without inventory.prices.read. */
  value: z.string().nullable(),
  /** The expiry date the goods came with (ADR 0062); null when none was given. */
  expiresOn: z.string().nullable().default(null),
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
  /** Sum of the line values in `warehouseId` (signed, 2 decimals); null without inventory.prices.read (ADR 0060). */
  value: z.string().nullable(),
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
  /** 4 decimals; null without inventory.prices.read (ADR 0060), like `value`. */
  averageCost: z.string().nullable(),
  /** quantity × average cost, 2 decimals. */
  value: z.string().nullable(),
  /** At or below the item's reorder level. */
  low: z.boolean(),
  /** The earliest expiry date of what is in stock (ADR 0062); null when unknown or nothing there. */
  expiresOn: z.string().nullable().default(null),
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

/** Recipes and dish costs (docs/modules/inventory.md → Step 2). */
export const RECIPE_MAX_LINES = 50;

export const putRecipeRequestSchema = z.strictObject({
  lines: z
    .array(z.strictObject({ itemId: z.uuid(), quantity: stockQuantitySchema }))
    .max(RECIPE_MAX_LINES)
    .refine(uniqueItems, { message: 'An item can be in a recipe only once' }),
});

export const recipeSchema = z.object({
  productId: z.uuid(),
  lines: z.array(
    z.object({
      itemId: z.uuid(),
      itemName: z.string(),
      unit: z.enum(STOCK_UNITS),
      /** 3 decimals. */
      quantity: z.string(),
    }),
  ),
});

export const dishCostSchema = z.object({
  productId: z.uuid(),
  /** Σ quantity × current cost, 2 decimals; the known part when incomplete. */
  cost: z.string(),
  /** Every item of the recipe has a cost. */
  complete: z.boolean(),
  lines: z.array(
    z.object({
      itemId: z.uuid(),
      quantity: z.string(),
      /** The item's current cost per unit, 4 decimals; null when it was never moved. */
      unitCost: z.string().nullable(),
    }),
  ),
});

export const dishCostListResponseSchema = z.object({ data: z.array(dishCostSchema) });

export type PutRecipeRequest = z.infer<typeof putRecipeRequestSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type DishCost = z.infer<typeof dishCostSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Inventory sub-modules (docs/modules/inventory.md → Step 5, ADR 0038)
// ---------------------------------------------------------------------------------------------------------------

const includeArchived = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');
const nothingToUpdate = {
  message: 'Nothing to update',
};

/** Base units per unit: up to 8 digits and 6 decimals, positive (a case of 24 → "24"). */
export const unitFactorSchema = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,6})?$/, 'Invalid factor')
  .refine((v) => /[1-9]/.test(v), 'Factor must be positive');

/** A unit of measurement: `factor` of `baseUnit` (Case = 24 pc, Sack = 25 kg). */
export const unitOfMeasureSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  symbol: z.string(),
  baseUnit: z.enum(STOCK_UNITS),
  /** 6 decimals. */
  factor: z.string(),
  archivedAt: z.iso.datetime().nullable(),
});

export const createUnitOfMeasureRequestSchema = z.strictObject({
  name,
  symbol: z.string().trim().min(1).max(20),
  baseUnit: z.enum(STOCK_UNITS),
  factor: unitFactorSchema,
});

/** The base unit never changes: receipts already converted with it. */
export const updateUnitOfMeasureRequestSchema = z
  .strictObject({
    name: name.optional(),
    symbol: z.string().trim().min(1).max(20).optional(),
    factor: unitFactorSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), nothingToUpdate);

export const listUnitsQuerySchema = z.object({ includeArchived });
export const unitOfMeasureListResponseSchema = z.object({ data: z.array(unitOfMeasureSchema) });

export const VARIANT_ATTRIBUTE_MAX_VALUES = 50;
export const VARIANT_VALUE_MAX_LENGTH = 40;
/** Combinations one "Generate variants" may create. */
export const MAX_VARIANTS_PER_ITEM = 100;

const attributeValues = z
  .array(z.string().trim().min(1).max(VARIANT_VALUE_MAX_LENGTH))
  .min(1)
  .max(VARIANT_ATTRIBUTE_MAX_VALUES)
  .refine((values) => new Set(values.map((v) => v.toLowerCase())).size === values.length, {
    message: 'Values must be unique',
  });

/** An attribute variants differ in, with its values in display order (Size: Small, Medium, Large). */
export const variantAttributeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  values: z.array(z.string()),
  archivedAt: z.iso.datetime().nullable(),
});

export const createVariantAttributeRequestSchema = z.strictObject({
  name,
  values: attributeValues,
});

export const updateVariantAttributeRequestSchema = z
  .strictObject({
    name: name.optional(),
    values: attributeValues.optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), nothingToUpdate);

export const listVariantAttributesQuerySchema = z.object({ includeArchived });
export const variantAttributeListResponseSchema = z.object({
  data: z.array(variantAttributeSchema),
});

/**
 * Generate an item's variants: every combination of the picked values (one list per attribute, in that order),
 * as new stock items in the parent's unit. Combinations that already exist are skipped.
 */
export const generateVariantsRequestSchema = z.strictObject({
  attributes: z
    .array(
      z.strictObject({
        attributeId: z.uuid(),
        values: z.array(z.string().trim().min(1).max(VARIANT_VALUE_MAX_LENGTH)).min(1),
      }),
    )
    .min(1)
    .max(3)
    .refine((list) => new Set(list.map((a) => a.attributeId)).size === list.length, {
      message: 'An attribute can be picked only once',
    }),
  /** The variants' article numbers start with it: `COLA` → `COLA-1`, `COLA-2`, … */
  skuPrefix: z.string().trim().min(1).max(40).optional(),
});

export const generateVariantsResponseSchema = z.object({
  created: z.array(stockItemSchema),
  /** Combinations that already had a variant. */
  skipped: z.int(),
});

export const BOM_MAX_LINES = 50;

/** What `outputQuantity` of a prepared item takes (1 l tomato sauce = 2 kg tomatoes + 0.1 l oil). */
export const putBomRequestSchema = z.strictObject({
  outputQuantity: stockQuantitySchema,
  lines: z
    .array(z.strictObject({ itemId: z.uuid(), quantity: stockQuantitySchema }))
    .min(1)
    .max(BOM_MAX_LINES)
    .refine(uniqueItems, { message: 'An item can be in a bill of materials only once' }),
});

export const bomSchema = z.object({
  /** The item it makes. */
  itemId: z.uuid(),
  itemName: z.string(),
  unit: z.enum(STOCK_UNITS),
  /** 3 decimals. */
  outputQuantity: z.string(),
  lines: z.array(
    z.object({
      itemId: z.uuid(),
      itemName: z.string(),
      unit: z.enum(STOCK_UNITS),
      /** 3 decimals. */
      quantity: z.string(),
    }),
  ),
  updatedAt: z.iso.datetime(),
});

export const bomListResponseSchema = z.object({ data: z.array(bomSchema) });

/**
 * Make `quantity` of an item with a bill of materials in a warehouse: its components go out at their average cost
 * (scaled by quantity ÷ the bill's output quantity) and the item comes in at their total cost.
 */
export const productionRequestSchema = z.strictObject({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  quantity: stockQuantitySchema,
  note: note.optional(),
});

export type UnitOfMeasure = z.infer<typeof unitOfMeasureSchema>;
export type CreateUnitOfMeasureRequest = z.infer<typeof createUnitOfMeasureRequestSchema>;
export type UpdateUnitOfMeasureRequest = z.infer<typeof updateUnitOfMeasureRequestSchema>;
export type ListUnitsQuery = z.infer<typeof listUnitsQuerySchema>;
export type VariantAttribute = z.infer<typeof variantAttributeSchema>;
export type CreateVariantAttributeRequest = z.infer<typeof createVariantAttributeRequestSchema>;
export type UpdateVariantAttributeRequest = z.infer<typeof updateVariantAttributeRequestSchema>;
export type ListVariantAttributesQuery = z.infer<typeof listVariantAttributesQuerySchema>;
export type GenerateVariantsRequest = z.infer<typeof generateVariantsRequestSchema>;
export type GenerateVariantsResponse = z.infer<typeof generateVariantsResponseSchema>;
export type PutBomRequest = z.infer<typeof putBomRequestSchema>;
export type Bom = z.infer<typeof bomSchema>;
export type ProductionRequest = z.infer<typeof productionRequestSchema>;

/** Stable error codes of the inventory endpoints; the web app shows the matching label. */
export const INVENTORY_ERROR_CODES = [
  'inventory.warehouse_not_found',
  'inventory.main_warehouse_not_allowed',
  'inventory.location_not_found',
  'inventory.item_not_found',
  'inventory.document_not_found',
  'inventory.warehouse_name_taken',
  'inventory.item_name_taken',
  'inventory.insufficient_stock',
  'inventory.unit_locked',
  'inventory.valuation_unsupported',
  'inventory.same_warehouse',
  'inventory.product_not_found',
  'inventory.station_taken',
  'inventory.unit_not_found',
  'inventory.unit_name_taken',
  'inventory.unit_mismatch',
  'inventory.attribute_not_found',
  'inventory.attribute_name_taken',
  'inventory.item_has_variants',
  'inventory.variant_not_allowed',
  'inventory.too_many_variants',
  'inventory.bom_not_found',
  'inventory.bom_invalid',
] as const;

export type InventoryErrorCode = (typeof INVENTORY_ERROR_CODES)[number];

/** `inventory.item_not_found` → `inventory.errors.itemNotFound`. */
export function inventoryErrorLabel(code: InventoryErrorCode): string {
  return `inventory.errors.${code.slice('inventory.'.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
