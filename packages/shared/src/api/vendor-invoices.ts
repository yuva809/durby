import { z } from 'zod';
import { INVENTORY_NAME_MAX_LENGTH, STOCK_DOCUMENT_MAX_LINES, STOCK_UNITS } from './inventory';

/**
 * Vendor invoices waiting for approval (docs/modules/inventory.md → Vendor invoices, ADR 0054). Read from the
 * supplier's PDF or photo in the browser, submitted as Pending (nothing in stock yet); someone with
 * inventory.invoices.approve at the warehouse approves (one goods receipt, new items created with it) or rejects.
 */

export const VENDOR_INVOICE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type VendorInvoiceStatus = (typeof VENDOR_INVOICE_STATUSES)[number];

export const VENDOR_INVOICE_SOURCES = ['pdf', 'scan'] as const;
export type VendorInvoiceSource = (typeof VENDOR_INVOICE_SOURCES)[number];

export const VENDOR_INVOICE_REASON_MAX_LENGTH = 500;
export const VENDOR_INVOICE_LIST_LIMIT = 200;

const text = (max: number) => z.string().trim().min(1).max(max);
const quantity = z.string().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Invalid quantity');
const unitCost = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'Invalid cost');

/**
 * What a line sets on an existing item when approved (ADR 0055): its category (null: uncategorized), brand and pack
 * size. Only what is given changes.
 */
export const vendorInvoiceItemDetailsSchema = z
  .strictObject({
    categoryId: z.uuid().nullable().optional(),
    brand: text(100).optional(),
    packCount: z.int().min(1).max(100_000).optional(),
    packSize: quantity.optional(),
    packUnit: z.enum(STOCK_UNITS).optional(),
  })
  .refine((d) => (d.packSize === undefined) === (d.packUnit === undefined), {
    message: 'A pack size needs its unit',
    path: ['packUnit'],
  });

/** A line: an existing item, or a new one created on approval (its SKU the supplier's product id). */
export const vendorInvoiceLineInputSchema = z
  .strictObject({
    /** As read from the invoice, kept for the approver. */
    code: text(50).nullable().optional(),
    description: text(300),
    itemId: z.uuid().nullable().optional(),
    newItem: z
      .strictObject({
        name: text(INVENTORY_NAME_MAX_LENGTH),
        sku: text(50).optional(),
        unit: z.enum(STOCK_UNITS),
        categoryId: z.uuid().nullable().optional(),
        /** Brand and pack size (ADR 0055), e.g. 12 x 500 g. */
        brand: text(100).optional(),
        packCount: z.int().min(1).max(100_000).optional(),
        packSize: quantity.optional(),
        packUnit: z.enum(STOCK_UNITS).optional(),
      })
      .refine((n) => (n.packSize === undefined) === (n.packUnit === undefined), {
        message: 'A pack size needs its unit',
        path: ['packUnit'],
      })
      .nullable()
      .optional(),
    /** With `itemId`: category, brand and pack size to set on that item when approved (ADR 0055). */
    itemDetails: vendorInvoiceItemDetailsSchema.nullable().optional(),
    /** The unit the supplier invoices in (ADR 0055): quantity and cost are in it. */
    unitId: z.uuid().nullable().optional(),
    quantity,
    unitCost,
    /** Best before, as printed (ADR 0062): goes with the goods into stock on approval. */
    expiresOn: z.iso.date().nullable().optional(),
  })
  .refine((l) => (l.itemId ? 1 : 0) + (l.newItem ? 1 : 0) === 1, {
    message: 'A line is an existing item or a new one',
  })
  .refine((l) => !l.itemDetails || l.itemId, {
    message: 'Item details belong to an existing item',
    path: ['itemDetails'],
  });

export const submitVendorInvoiceRequestSchema = z
  .strictObject({
    warehouseId: z.uuid(),
    supplier: text(INVENTORY_NAME_MAX_LENGTH).optional(),
    /** The supplier's number and date, as printed. */
    invoiceNumber: text(50).optional(),
    invoiceDate: text(20).optional(),
    note: z.string().trim().max(500).optional(),
    /** The printed grand total, 2 decimals, for the approver's check. */
    printedTotal: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .optional(),
    fileName: text(200).optional(),
    source: z.enum(VENDOR_INVOICE_SOURCES),
    lines: z.array(vendorInvoiceLineInputSchema).min(1).max(STOCK_DOCUMENT_MAX_LINES),
  })
  .refine(
    (body) => {
      const ids = body.lines.flatMap((l) => (l.itemId ? [l.itemId] : []));
      const names = body.lines.flatMap((l) => (l.newItem ? [l.newItem.name.trim()] : []));
      return new Set(ids).size === ids.length && new Set(names).size === names.length;
    },
    { message: 'An item can be on the invoice only once' },
  );

/** While pending: the same fields again (lines replaced as a whole). */
export const updateVendorInvoiceRequestSchema = submitVendorInvoiceRequestSchema;

export const rejectVendorInvoiceRequestSchema = z.strictObject({
  reason: text(VENDOR_INVOICE_REASON_MAX_LENGTH),
});

export const listVendorInvoicesQuerySchema = z.object({
  status: z.enum(VENDOR_INVOICE_STATUSES).optional(),
});

export const vendorInvoiceLineSchema = z.object({
  id: z.uuid(),
  position: z.int(),
  code: z.string().nullable(),
  description: z.string(),
  itemId: z.uuid().nullable(),
  itemName: z.string().nullable(),
  newItem: z
    .object({
      name: z.string(),
      sku: z.string().nullable(),
      unit: z.enum(STOCK_UNITS),
      categoryId: z.uuid().nullable(),
      /** ADR 0055; defaults for older apis. */
      brand: z.string().nullable().default(null),
      packCount: z.int().nullable().default(null),
      packSize: z.string().nullable().default(null),
      packUnit: z.enum(STOCK_UNITS).nullable().default(null),
    })
    .nullable(),
  /** On an existing item's line: what approval sets on the item (ADR 0055); null when nothing. */
  itemDetails: z
    .object({
      categoryId: z.uuid().nullable(),
      brand: z.string().nullable(),
      packCount: z.int().nullable(),
      packSize: z.string().nullable(),
      packUnit: z.enum(STOCK_UNITS).nullable(),
    })
    .nullable()
    .default(null),
  /** The unit the supplier invoices in (ADR 0055), with its symbol; quantity and cost are in it. */
  unitId: z.uuid().nullable().default(null),
  unitSymbol: z.string().nullable().default(null),
  quantity: z.string(),
  unitCost: z.string(),
  /** quantity × unit cost, 2 decimals. */
  value: z.string(),
  /** Best before (ADR 0062); default for older apis. */
  expiresOn: z.string().nullable().default(null),
});

export const vendorInvoiceSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  status: z.enum(VENDOR_INVOICE_STATUSES),
  warehouseId: z.uuid(),
  warehouseName: z.string(),
  supplier: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  lineCount: z.int(),
  newItemCount: z.int(),
  /** The lines' value, 2 decimals. */
  total: z.string(),
  printedTotal: z.string().nullable(),
  submittedByName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});

export const vendorInvoiceSchema = vendorInvoiceSummarySchema.extend({
  note: z.string().nullable(),
  fileName: z.string().nullable(),
  source: z.enum(VENDOR_INVOICE_SOURCES),
  rejectReason: z.string().nullable(),
  decidedByName: z.string().nullable(),
  /** The goods receipt booked on approval. */
  documentId: z.uuid().nullable(),
  documentNumber: z.string().nullable(),
  lines: z.array(vendorInvoiceLineSchema),
});

export const vendorInvoiceListResponseSchema = z.object({
  data: z.array(vendorInvoiceSummarySchema),
});

export type VendorInvoiceLineInput = z.infer<typeof vendorInvoiceLineInputSchema>;
export type SubmitVendorInvoiceRequest = z.infer<typeof submitVendorInvoiceRequestSchema>;
export type UpdateVendorInvoiceRequest = z.infer<typeof updateVendorInvoiceRequestSchema>;
export type RejectVendorInvoiceRequest = z.infer<typeof rejectVendorInvoiceRequestSchema>;
export type ListVendorInvoicesQuery = z.infer<typeof listVendorInvoicesQuerySchema>;
export type VendorInvoiceLine = z.infer<typeof vendorInvoiceLineSchema>;
export type VendorInvoiceSummary = z.infer<typeof vendorInvoiceSummarySchema>;
export type VendorInvoice = z.infer<typeof vendorInvoiceSchema>;

export const VENDOR_INVOICE_ERROR_CODES = [
  'inventory.vendor_invoice_not_found',
  'inventory.vendor_invoice_decided',
] as const;
export type VendorInvoiceErrorCode = (typeof VENDOR_INVOICE_ERROR_CODES)[number];
