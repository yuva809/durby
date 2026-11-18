import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  type ImportReceiptRequest,
  type ListVendorInvoicesQuery,
  type NotificationKind,
  type RejectVendorInvoiceRequest,
  type StockUnit,
  type SubmitVendorInvoiceRequest,
  type UpdateVendorInvoiceRequest,
  VENDOR_INVOICE_LIST_LIMIT,
  type VendorInvoice,
  type VendorInvoiceStatus,
  type VendorInvoiceSummary,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { ApiError } from '../../platform/http';
import { IdempotencyService } from '../../platform/idempotency';
import { NotificationService } from '../../platform/notifications';
import { NumberingService } from '../../platform/numbering';
import { AccessService, MemberNames } from '../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { CatalogService } from '../catalog';
import { inventoryErrors } from './inventory-errors';
import { StockService } from './stock.service';

export const vendorInvoiceErrors = {
  notFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'inventory.vendor_invoice_not_found',
      'Vendor invoice not found.',
    ),
  /** Approved or rejected already (or changed meanwhile): reload. */
  decided: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'inventory.vendor_invoice_decided',
      'This invoice was approved, rejected or changed meanwhile.',
    ),
};

const SELECT = {
  id: true,
  number: true,
  status: true,
  warehouseId: true,
  supplier: true,
  invoiceNumber: true,
  invoiceDate: true,
  note: true,
  printedTotal: true,
  fileName: true,
  source: true,
  submittedBy: true,
  decidedBy: true,
  decidedAt: true,
  rejectReason: true,
  documentId: true,
  createdAt: true,
  updatedAt: true,
  warehouse: { select: { name: true, locationId: true } },
  document: { select: { number: true } },
  lines: {
    select: {
      id: true,
      position: true,
      code: true,
      description: true,
      itemId: true,
      newItemName: true,
      newItemSku: true,
      newItemUnit: true,
      newItemCategoryId: true,
      quantity: true,
      unitCost: true,
      item: { select: { name: true } },
    },
    orderBy: { position: 'asc' },
  },
} as const;

type Dec = { toFixed(digits: number): string };
interface Row {
  id: string;
  number: string;
  status: string;
  warehouseId: string;
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  note: string | null;
  printedTotal: Dec | null;
  fileName: string | null;
  source: string;
  submittedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  rejectReason: string | null;
  documentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  warehouse: { name: string; locationId: string };
  document: { number: string } | null;
  lines: {
    id: string;
    position: number;
    code: string | null;
    description: string;
    itemId: string | null;
    newItemName: string | null;
    newItemSku: string | null;
    newItemUnit: StockUnit | null;
    newItemCategoryId: string | null;
    quantity: Dec;
    unitCost: Dec;
    item: { name: string } | null;
  }[];
}

/**
 * Vendor invoices waiting for approval (docs/modules/inventory.md → Vendor invoices, ADR 0054). Submitted by those who
 * receive goods at the warehouse; approved or rejected by inventory.invoices.approve there. Approval books one goods
 * receipt (new items created with it, the approval standing in for inventory.items.edit) and marks the invoice in the
 * same transaction; it only succeeds while the invoice is pending and unchanged since it was read.
 */
@Injectable()
export class VendorInvoicesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly numbering: NumberingService,
    private readonly stock: StockService,
    private readonly catalog: CatalogService,
    private readonly members: MemberNames,
    private readonly notifications: NotificationService,
  ) {}

  async list(query: ListVendorInvoicesQuery): Promise<VendorInvoiceSummary[]> {
    const locations = await this.visibleLocations();
    if (locations !== 'all' && locations.length === 0) return [];
    const rows: Row[] = await this.db.vendorInvoice.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(locations === 'all' ? {} : { warehouse: { locationId: { in: locations } } }),
      },
      select: SELECT,
      orderBy: { id: 'desc' },
      take: VENDOR_INVOICE_LIST_LIMIT,
    });
    const names = await this.members.forUsers(
      asTenantDb(this.db),
      rows.map((r) => r.submittedBy),
    );
    return rows.map((r) => summaryOf(r, names));
  }

  async get(id: string): Promise<VendorInvoice> {
    return this.read(this.db, await this.visible(id));
  }

  async submit(body: SubmitVendorInvoiceRequest): Promise<VendorInvoice> {
    const { tenantId, userId } = this.tenantContext.require();
    const warehouse = await this.usableWarehouse(body.warehouseId);
    await this.checkLines(body);
    return this.db.$transaction(async (tx) => {
      const { number } = await this.numbering.next('inventory.vendorInvoice', tx);
      const row = await tx.vendorInvoice.create({
        data: { tenantId, number, submittedBy: userId, ...header(body) },
        select: { id: true },
      });
      await this.writeLines(tx, tenantId, row.id, body);
      const response = await this.read(tx, row.id);
      await this.audit.record(tx, {
        action: 'inventory.vendor_invoice.submitted',
        actor: auditActor.user(userId),
        entityId: row.id,
        after: snapshot('vendor_invoice', response),
      });
      const approvers = await this.members.holders(
        asTenantDb(tx),
        'inventory.invoices.approve',
        warehouse.locationId,
      );
      await this.notify(
        tx,
        'invoice_submitted',
        response,
        approvers.map((h) => h.userId),
      );
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** While pending: header and lines replaced, by an approver or the person who submitted it. */
  async update(id: string, body: UpdateVendorInvoiceRequest): Promise<VendorInvoice> {
    const { tenantId, userId } = this.tenantContext.require();
    const current = await this.visible(id);
    const approver = await this.access.can('inventory.invoices.approve', {
      locationId: current.warehouse.locationId,
    });
    if (!approver && current.submittedBy !== userId) throw vendorInvoiceErrors.notFound();
    if (current.status !== 'pending') throw vendorInvoiceErrors.decided();
    await this.usableWarehouse(body.warehouseId);
    await this.checkLines(body);
    return this.db.$transaction(async (tx) => {
      const before = await this.read(tx, id);
      const { count } = await tx.vendorInvoice.updateMany({
        where: { id, status: 'pending', updatedAt: current.updatedAt },
        data: header(body),
      });
      if (count === 0) throw vendorInvoiceErrors.decided();
      await tx.vendorInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await this.writeLines(tx, tenantId, id, body);
      const after = await this.read(tx, id);
      await this.audit.record(tx, {
        action: 'inventory.vendor_invoice.updated',
        actor: auditActor.user(userId),
        entityId: id,
        before: snapshot('vendor_invoice', before),
        after: snapshot('vendor_invoice', after),
      });
      return after;
    });
  }

  async approve(id: string): Promise<VendorInvoice> {
    const { userId } = this.tenantContext.require();
    const row = await this.visible(id);
    await this.access.assert('inventory.invoices.approve', {
      locationId: row.warehouse.locationId,
    });
    if (row.status !== 'pending') throw vendorInvoiceErrors.decided();
    let result: VendorInvoice | null = null;
    await this.stock.importReceipt(receiptOf(row), {
      // The approval accepts the invoice's new items: no separate inventory.items.edit.
      newItemsApproved: true,
      complete: async (tx, document) => {
        const before = await this.read(tx, id);
        const { count } = await tx.vendorInvoice.updateMany({
          where: { id, status: 'pending', updatedAt: row.updatedAt },
          data: {
            status: 'approved',
            decidedBy: userId,
            decidedAt: new Date(),
            documentId: document.id,
          },
        });
        if (count === 0) throw vendorInvoiceErrors.decided();
        const after = await this.read(tx, id);
        await this.audit.record(tx, {
          action: 'inventory.vendor_invoice.approved',
          actor: auditActor.user(userId),
          entityId: id,
          before: snapshot('vendor_invoice', before),
          after: snapshot('vendor_invoice', after),
        });
        await this.notify(tx, 'invoice_approved', after, [row.submittedBy]);
        result = after;
        return after;
      },
    });
    return result!;
  }

  async reject(id: string, body: RejectVendorInvoiceRequest): Promise<VendorInvoice> {
    const { userId } = this.tenantContext.require();
    const row = await this.visible(id);
    await this.access.assert('inventory.invoices.approve', {
      locationId: row.warehouse.locationId,
    });
    if (row.status !== 'pending') throw vendorInvoiceErrors.decided();
    return this.db.$transaction(async (tx) => {
      const before = await this.read(tx, id);
      const { count } = await tx.vendorInvoice.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'rejected',
          decidedBy: userId,
          decidedAt: new Date(),
          rejectReason: body.reason,
        },
      });
      if (count === 0) throw vendorInvoiceErrors.decided();
      const after = await this.read(tx, id);
      await this.audit.record(tx, {
        action: 'inventory.vendor_invoice.rejected',
        actor: auditActor.user(userId),
        entityId: id,
        before: snapshot('vendor_invoice', before),
        after: snapshot('vendor_invoice', after),
      });
      await this.notify(tx, 'invoice_rejected', after, [row.submittedBy]);
      await this.idempotency.completeInTransaction(tx, after);
      return after;
    });
  }

  // -------------------------------------------------------------------------------------------------------------

  /** Locations whose invoices the caller sees: where they receive goods or approve invoices. */
  private async visibleLocations(): Promise<'all' | string[]> {
    const [receive, approve] = await Promise.all([
      this.access.locationIdsFor('inventory.stock.receive'),
      this.access.locationIdsFor('inventory.invoices.approve'),
    ]);
    if (receive === 'all' || approve === 'all') return 'all';
    return [...new Set([...receive, ...approve])];
  }

  private async visible(id: string): Promise<Row> {
    const row: Row | null = await this.db.vendorInvoice.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!row) throw vendorInvoiceErrors.notFound();
    const locations = await this.visibleLocations();
    if (locations !== 'all' && !locations.includes(row.warehouse.locationId)) {
      throw vendorInvoiceErrors.notFound();
    }
    return row;
  }

  /** An active, non-transit warehouse where the caller receives goods. */
  private async usableWarehouse(id: string): Promise<{ locationId: string }> {
    const warehouse = await this.db.warehouse.findUnique({
      where: { id },
      select: { locationId: true, archivedAt: true, isTransit: true },
    });
    if (
      !warehouse ||
      warehouse.archivedAt ||
      warehouse.isTransit ||
      !(await this.access.can('inventory.stock.read', { locationId: warehouse.locationId }))
    ) {
      throw inventoryErrors.warehouseNotFound();
    }
    await this.access.assert('inventory.stock.receive', { locationId: warehouse.locationId });
    return warehouse;
  }

  /** Existing items active; new items' categories active (checked again on approval). */
  private async checkLines(body: SubmitVendorInvoiceRequest): Promise<void> {
    const ids = body.lines.flatMap((l) => (l.itemId ? [l.itemId] : []));
    if (ids.length > 0) {
      const found = await this.db.stockItem.findMany({
        where: { id: { in: ids }, archivedAt: null },
        select: { id: true },
      });
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length > 0) throw inventoryErrors.itemNotFound(missing);
    }
    const categories = new Set(
      body.lines.flatMap((l) => (l.newItem?.categoryId ? [l.newItem.categoryId] : [])),
    );
    for (const categoryId of categories) await this.catalog.assertActiveCategory(categoryId);
  }

  private async writeLines(
    tx: TenantTransactionClient,
    tenantId: string,
    invoiceId: string,
    body: SubmitVendorInvoiceRequest,
  ): Promise<void> {
    await tx.vendorInvoiceLine.createMany({
      data: body.lines.map((l, position) => ({
        tenantId,
        invoiceId,
        position,
        code: l.code ?? null,
        description: l.description,
        itemId: l.itemId ?? null,
        newItemName: l.newItem?.name.trim() ?? null,
        newItemSku: l.newItem?.sku ?? null,
        newItemUnit: l.newItem?.unit ?? null,
        newItemCategoryId: l.newItem?.categoryId ?? null,
        quantity: new Decimal(l.quantity).toFixed(3),
        unitCost: new Decimal(l.unitCost).toFixed(4),
      })),
    });
  }

  private async read(db: TenantPrismaClient | TenantTransactionClient, idOrRow: string | Row) {
    const row: Row =
      typeof idOrRow === 'string'
        ? await (db as TenantTransactionClient).vendorInvoice.findUniqueOrThrow({
            where: { id: idOrRow },
            select: SELECT,
          })
        : idOrRow;
    const names = await this.members.forUsers(asTenantDb(db), [
      row.submittedBy,
      ...(row.decidedBy ? [row.decidedBy] : []),
    ]);
    return invoiceOf(row, names);
  }

  private notify(
    tx: TenantTransactionClient,
    kind: NotificationKind,
    invoice: VendorInvoice,
    userIds: readonly string[],
  ) {
    return this.notifications.notify(tx, {
      userIds,
      kind,
      entityType: 'vendor_invoice',
      entityId: invoice.id,
      params: {
        number: invoice.number,
        supplier: invoice.supplier ?? invoice.invoiceNumber ?? invoice.number,
      },
    });
  }
}

function header(body: SubmitVendorInvoiceRequest) {
  return {
    warehouseId: body.warehouseId,
    supplier: body.supplier ?? null,
    invoiceNumber: body.invoiceNumber ?? null,
    invoiceDate: body.invoiceDate ?? null,
    note: body.note || null,
    printedTotal: body.printedTotal ?? null,
    fileName: body.fileName ?? null,
    source: body.source,
  };
}

/** The goods receipt an approval books: the supplier's number and date as its note when there is no note. */
function receiptOf(row: Row): ImportReceiptRequest {
  const note =
    row.note ??
    [row.number, row.invoiceNumber, row.invoiceDate].filter((x): x is string => !!x).join(' · ');
  return {
    warehouseId: row.warehouseId,
    ...(row.supplier ? { supplier: row.supplier } : {}),
    ...(note ? { note: note.slice(0, 500) } : {}),
    lines: row.lines.map((l) => {
      const amounts = { quantity: l.quantity.toFixed(3), unitCost: l.unitCost.toFixed(4) };
      if (l.itemId) return { itemId: l.itemId, ...amounts };
      return {
        newItem: {
          name: l.newItemName!,
          ...(l.newItemSku ? { sku: l.newItemSku } : {}),
          unit: l.newItemUnit!,
          ...(l.newItemCategoryId ? { categoryId: l.newItemCategoryId } : {}),
        },
        ...amounts,
      };
    }),
  };
}

const value = (l: Row['lines'][number]) =>
  new Decimal(l.quantity.toFixed(3)).times(l.unitCost.toFixed(4)).toDecimalPlaces(2);

function summaryOf(row: Row, names: ReadonlyMap<string, string>): VendorInvoiceSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status as VendorInvoiceStatus,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse.name,
    supplier: row.supplier,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    lineCount: row.lines.length,
    newItemCount: row.lines.filter((l) => l.itemId === null).length,
    total: row.lines.reduce((sum, l) => sum.plus(value(l)), new Decimal(0)).toFixed(2),
    printedTotal: row.printedTotal?.toFixed(2) ?? null,
    submittedByName: names.get(row.submittedBy) ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function invoiceOf(row: Row, names: ReadonlyMap<string, string>): VendorInvoice {
  return {
    ...summaryOf(row, names),
    note: row.note,
    fileName: row.fileName,
    source: row.source as VendorInvoice['source'],
    rejectReason: row.rejectReason,
    decidedByName: row.decidedBy ? (names.get(row.decidedBy) ?? null) : null,
    documentId: row.documentId,
    documentNumber: row.document?.number ?? null,
    lines: row.lines.map((l) => ({
      id: l.id,
      position: l.position,
      code: l.code,
      description: l.description,
      itemId: l.itemId,
      itemName: l.item?.name ?? null,
      newItem:
        l.itemId === null
          ? {
              name: l.newItemName ?? '',
              sku: l.newItemSku,
              unit: l.newItemUnit ?? 'pc',
              categoryId: l.newItemCategoryId,
            }
          : null,
      quantity: l.quantity.toFixed(3),
      unitCost: l.unitCost.toFixed(4),
      value: value(l).toFixed(2),
    })),
  };
}
