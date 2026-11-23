import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type {
  AdjustmentReason,
  AuditActor,
  DataImportResult,
  ImportOpeningStockRequest,
  EventPayload,
  ImportReceiptRequest,
  ItemMovements,
  AdjustmentRequest,
  ListStockDocumentsQuery,
  NumberSeriesKey,
  PermissionKey,
  ProductionRequest,
  ReceiptRequest,
  StockDocument,
  StockDocumentKind,
  StockDocumentSummary,
  StockLevel,
  StockQuery,
  StockUnit,
  TransferRequest,
} from '@durby/shared';
import { checkOpeningStockRows, ITEM_MOVEMENTS_LIMIT } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { SettingsService } from '../../platform/config/settings';
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
import { ITEM_SELECT, itemResponse, itemSnapshot } from './setup.service';
import { componentNeeds, outputUnitCost, toBaseUnits } from './item-rules';
import { bookIn, bookOut, costText, type Level, quantityText, valueOf } from './valuation';

/** Prisma returns `numeric` columns as Decimal objects; only their exact text is used here. */
type DecimalValue = { toFixed(digits: number): string };

const SERIES: Record<StockDocumentKind, NumberSeriesKey> = {
  receipt: 'inventory.goodsReceipt',
  adjustment: 'inventory.stockAdjustment',
  transfer: 'inventory.stockTransfer',
  consumption: 'inventory.stockConsumption',
  production: 'inventory.stockProduction',
  issue: 'inventory.goodsIssue',
  restock: 'inventory.goodsRestock',
};

const DOCUMENT_LIST_LIMIT = 200;

const DOCUMENT_SELECT = {
  id: true,
  number: true,
  kind: true,
  warehouseId: true,
  toWarehouseId: true,
  reason: true,
  supplier: true,
  note: true,
  createdAt: true,
  warehouse: { select: { name: true } },
  toWarehouse: { select: { name: true } },
  movements: {
    select: {
      id: true,
      warehouseId: true,
      itemId: true,
      quantity: true,
      unitCost: true,
      value: true,
      expiresOn: true,
      item: { select: { name: true, unit: true } },
    },
    orderBy: { id: 'asc' },
  },
} as const;

interface DocumentRow {
  id: string;
  number: string;
  kind: StockDocumentKind;
  warehouseId: string;
  toWarehouseId: string | null;
  reason: AdjustmentReason | null;
  supplier: string | null;
  note: string | null;
  createdAt: Date;
  warehouse: { name: string };
  toWarehouse: { name: string } | null;
  movements: {
    id: string;
    warehouseId: string;
    itemId: string;
    quantity: DecimalValue;
    unitCost: DecimalValue;
    value: DecimalValue;
    expiresOn: Date | null;
    item: { name: string; unit: StockUnit };
  }[];
}

/** One movement to write: signed quantity in a warehouse, with the expiry date the goods carry (ADR 0062). */
interface PlannedMovement {
  warehouseId: string;
  itemId: string;
  quantity: Decimal;
  unitCost: Decimal;
  expiresOn?: string | null;
}

/** A date column as "2027-03-31" (Prisma reads DATE as UTC midnight). */
const dateText = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

interface WarehouseRef {
  id: string;
  locationId: string;
}

/**
 * Receipts, adjustments and transfers, and what is in stock (docs/modules/inventory.md, ADR 0027).
 * Each document: check access, warehouses and items; lock the levels it touches (in a fixed order);
 * value the lines by weighted average; refuse negative stock unless allowed; then number, write
 * the document and its movements, update the levels and audit, all in one transaction.
 */
@Injectable()
export class StockService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
    private readonly catalog: CatalogService,
    private readonly members: MemberNames,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * A delivery. Lines with a unit of measurement are converted to the item's unit first (ADR 0038): the unit's base
   * unit must be the item's unit.
   */
  receive(body: ReceiptRequest): Promise<StockDocument> {
    // Best before per line, as given (ADR 0062).
    const expiry = body.lines.map((l) => l.expiresOn ?? null);
    let lines = body.lines.map((l) => ({
      itemId: l.itemId,
      quantity: new Decimal(l.quantity),
      unitCost: new Decimal(l.unitCost),
    }));
    return this.post({
      kind: 'receipt',
      key: 'inventory.stock.receive',
      warehouseId: body.warehouseId,
      itemIds: body.lines.map((l) => l.itemId),
      prepare: async (tx) => {
        const unitIds = [...new Set(body.lines.flatMap((l) => (l.unitId ? [l.unitId] : [])))];
        if (unitIds.length === 0) return;
        const [units, items] = await Promise.all([
          tx.unitOfMeasure.findMany({
            where: { id: { in: unitIds }, archivedAt: null },
            select: { id: true, baseUnit: true, factor: true },
          }),
          tx.stockItem.findMany({
            where: { id: { in: body.lines.map((l) => l.itemId) } },
            select: { id: true, unit: true },
          }),
        ]);
        const unitById = new Map(units.map((u) => [u.id, u]));
        const missing = unitIds.filter((id) => !unitById.has(id));
        if (missing.length > 0) throw inventoryErrors.unitNotFound(missing);
        const itemUnit = new Map(items.map((i) => [i.id, i.unit]));
        const mismatched: string[] = [];
        lines = body.lines.map((line, i) => {
          const unit = line.unitId ? unitById.get(line.unitId)! : null;
          if (!unit) return lines[i]!;
          const base =
            unit.baseUnit === itemUnit.get(line.itemId)
              ? toBaseUnits(
                  new Decimal(line.quantity),
                  new Decimal(line.unitCost),
                  new Decimal(unit.factor.toFixed(6)),
                )
              : null;
          if (!base) {
            mismatched.push(line.itemId);
            return lines[i]!;
          }
          return { itemId: line.itemId, ...base };
        });
        if (mismatched.length > 0) throw inventoryErrors.unitMismatch(mismatched);
      },
      header: { supplier: body.supplier ?? null, note: body.note || null },
      plan: (levels) =>
        lines.map((line, index) => {
          const quantity = line.quantity;
          const booked = bookIn(
            levels.get(body.warehouseId, line.itemId),
            quantity,
            line.unitCost,
            expiry[index] ?? null,
          );
          levels.set(body.warehouseId, line.itemId, booked.level);
          return {
            warehouseId: body.warehouseId,
            itemId: line.itemId,
            quantity,
            unitCost: booked.unitCost,
            expiresOn: booked.expiresOn,
          };
        }),
    });
  }

  /**
   * A vendor invoice as one goods receipt (docs/modules/inventory.md → Vendor invoices, ADR 0049): lines naming an
   * existing item, or a new one created first in the same transaction (needs inventory.items.edit; an active
   * category; a name no active item has). Quantities and costs are in the item's unit. All or nothing.
   */
  async importReceipt(
    body: ImportReceiptRequest,
    options: {
      complete?: (tx: TenantTransactionClient, document: StockDocument) => Promise<unknown>;
      /** An approved vendor invoice (ADR 0054): its approval stands in for inventory.items.edit. */
      newItemsApproved?: boolean;
    } = {},
  ): Promise<StockDocument> {
    const { tenantId, userId } = this.tenantContext.require();
    const fresh = body.lines.flatMap((l) => ('newItem' in l ? [l.newItem] : []));
    if (fresh.length > 0 && !options.newItemsApproved)
      await this.access.assert('inventory.items.edit');
    // Existing items' details to set as they are received (ADR 0055).
    const updates = body.lines.flatMap((l) =>
      'itemId' in l && l.itemDetails ? [{ itemId: l.itemId, details: l.itemDetails }] : [],
    );
    if (updates.length > 0 && !options.newItemsApproved)
      await this.access.assert('inventory.items.edit');
    const categoryIds = new Set(
      [...fresh, ...updates.map((u) => u.details)].flatMap((n) =>
        n.categoryId ? [n.categoryId] : [],
      ),
    );
    for (const categoryId of categoryIds) await this.catalog.assertActiveCategory(categoryId);
    // The item of each line, by position: new ones are filled in once created.
    const lineItems = body.lines.map((l) => ('itemId' in l ? l.itemId : null));
    // Lines in a unit of measurement (ADR 0055): converted to the item's unit, whose base unit it must be.
    const converted = await this.invoiceUnits(body);
    return this.post({
      kind: 'receipt',
      key: 'inventory.stock.receive',
      warehouseId: body.warehouseId,
      itemIds: lineItems.filter((id): id is string => id !== null),
      create: async (tx) => {
        for (const update of updates) await this.setItemDetails(tx, userId, update);
        if (fresh.length === 0) return [];
        const taken = await tx.stockItem.findFirst({
          where: { name: { in: fresh.map((n) => n.name.trim()) }, archivedAt: null },
          select: { id: true },
        });
        if (taken) throw inventoryErrors.itemNameTaken();
        const created: string[] = [];
        for (const [index, line] of body.lines.entries()) {
          if (!('newItem' in line)) continue;
          const row = await tx.stockItem.create({
            data: {
              tenantId,
              name: line.newItem.name.trim(),
              sku: line.newItem.sku ?? null,
              unit: line.newItem.unit,
              categoryId: line.newItem.categoryId ?? null,
              brand: line.newItem.brand ?? null,
              packCount: line.newItem.packCount ?? null,
              packSize: line.newItem.packSize ?? null,
              packUnit: line.newItem.packUnit ?? null,
            },
            select: ITEM_SELECT,
          });
          await this.audit.record(tx, {
            action: 'inventory.stock_item.created',
            actor: auditActor.user(userId),
            entityId: row.id,
            after: itemSnapshot(itemResponse(row)),
          });
          lineItems[index] = row.id;
          created.push(row.id);
        }
        return created;
      },
      header: { supplier: body.supplier ?? null, note: body.note || null },
      complete: options.complete,
      plan: (levels) =>
        body.lines.map((line, index) => {
          const itemId = lineItems[index]!;
          const { quantity, unitCost } = converted[index]!;
          const booked = bookIn(
            levels.get(body.warehouseId, itemId),
            quantity,
            unitCost,
            line.expiresOn ?? null,
          );
          levels.set(body.warehouseId, itemId, booked.level);
          return {
            warehouseId: body.warehouseId,
            itemId,
            quantity,
            unitCost: booked.unitCost,
            expiresOn: booked.expiresOn,
          };
        }),
    });
  }

  /** An item's category, brand and pack size as an approved invoice line gives them (ADR 0055); audited when changed. */
  private async setItemDetails(
    tx: TenantTransactionClient,
    userId: string,
    update: {
      itemId: string;
      details: {
        categoryId?: string | null;
        brand?: string;
        packCount?: number;
        packSize?: string;
        packUnit?: StockUnit;
      };
    },
  ): Promise<void> {
    const current = await tx.stockItem.findUnique({
      where: { id: update.itemId },
      select: ITEM_SELECT,
    });
    if (!current) throw inventoryErrors.itemNotFound([update.itemId]);
    const { details } = update;
    const before = itemResponse(current);
    const next = {
      ...before,
      categoryId: details.categoryId === undefined ? before.categoryId : details.categoryId,
      brand: details.brand ?? before.brand,
      packCount: details.packCount ?? before.packCount,
      packSize: details.packSize ? new Decimal(details.packSize).toFixed(3) : before.packSize,
      packUnit: details.packUnit ?? before.packUnit,
    };
    if (JSON.stringify(itemSnapshot(before)) === JSON.stringify(itemSnapshot(next))) return;
    const row = await tx.stockItem.update({
      where: { id: update.itemId },
      data: {
        categoryId: next.categoryId,
        brand: next.brand,
        packCount: next.packCount,
        packSize: next.packSize,
        packUnit: next.packUnit,
      },
      select: ITEM_SELECT,
    });
    await this.audit.record(tx, {
      action: 'inventory.stock_item.updated',
      actor: auditActor.user(userId),
      entityId: row.id,
      before: itemSnapshot(before),
      after: itemSnapshot(itemResponse(row)),
    });
  }

  /**
   * Each import line's quantity and cost in its item's unit: as given, or converted from its unit of measurement
   * (ADR 0055), whose base unit must be the item's (an existing item's, or the new item's).
   */
  private async invoiceUnits(
    body: ImportReceiptRequest,
  ): Promise<{ quantity: Decimal; unitCost: Decimal }[]> {
    const plain = body.lines.map((l) => ({
      quantity: new Decimal(l.quantity),
      unitCost: new Decimal(l.unitCost),
    }));
    const unitIds = [...new Set(body.lines.flatMap((l) => (l.unitId ? [l.unitId] : [])))];
    if (unitIds.length === 0) return plain;
    const existing = body.lines.flatMap((l) => ('itemId' in l ? [l.itemId] : []));
    const [units, items] = await Promise.all([
      this.db.unitOfMeasure.findMany({
        where: { id: { in: unitIds }, archivedAt: null },
        select: { id: true, baseUnit: true, factor: true },
      }),
      this.db.stockItem.findMany({
        where: { id: { in: existing } },
        select: { id: true, unit: true },
      }),
    ]);
    const unitById = new Map(units.map((u) => [u.id, u]));
    const missing = unitIds.filter((id) => !unitById.has(id));
    if (missing.length > 0) throw inventoryErrors.unitNotFound(missing);
    const itemUnit = new Map(items.map((i) => [i.id, i.unit]));
    const mismatched: string[] = [];
    const result = body.lines.map((line, i) => {
      const unit = line.unitId ? unitById.get(line.unitId)! : null;
      if (!unit) return plain[i]!;
      const base = 'itemId' in line ? itemUnit.get(line.itemId) : line.newItem.unit;
      const converted =
        unit.baseUnit === base
          ? toBaseUnits(
              new Decimal(line.quantity),
              new Decimal(line.unitCost),
              new Decimal(unit.factor.toFixed(6)),
            )
          : null;
      if (!converted) {
        mismatched.push('itemId' in line ? line.itemId : line.newItem.name);
        return plain[i]!;
      }
      return converted;
    });
    if (mismatched.length > 0) throw inventoryErrors.unitMismatch(mismatched);
    return result;
  }

  adjust(body: AdjustmentRequest): Promise<StockDocument> {
    return this.post({
      kind: 'adjustment',
      key: 'inventory.stock.adjust',
      warehouseId: body.warehouseId,
      itemIds: body.lines.map((l) => l.itemId),
      header: { reason: body.reason, note: body.note || null },
      plan: (levels) =>
        body.lines.map((line) => {
          const quantity = new Decimal(line.quantity);
          const current = levels.get(body.warehouseId, line.itemId);
          // Found stock comes in at the current average; removed stock goes out at it.
          const booked = quantity.isPositive()
            ? bookIn(current, quantity, current.averageCost)
            : bookOut(current, quantity.negated());
          levels.set(body.warehouseId, line.itemId, booked.level);
          return {
            warehouseId: body.warehouseId,
            itemId: line.itemId,
            quantity,
            unitCost: booked.unitCost,
          };
        }),
    });
  }

  transfer(body: TransferRequest): Promise<StockDocument> {
    if (body.fromWarehouseId === body.toWarehouseId) throw inventoryErrors.sameWarehouse();
    return this.post({
      kind: 'transfer',
      key: 'inventory.stock.transfer',
      warehouseId: body.fromWarehouseId,
      toWarehouseId: body.toWarehouseId,
      itemIds: body.lines.map((l) => l.itemId),
      header: { note: body.note || null },
      plan: (levels) =>
        body.lines.flatMap((line) => {
          const quantity = new Decimal(line.quantity);
          const out = bookOut(levels.get(body.fromWarehouseId, line.itemId), quantity);
          levels.set(body.fromWarehouseId, line.itemId, out.level);
          // The stock brings its cost and expiry date along, like a receipt at the source's average.
          const into = bookIn(
            levels.get(body.toWarehouseId, line.itemId),
            quantity,
            out.unitCost,
            out.expiresOn,
          );
          levels.set(body.toWarehouseId, line.itemId, into.level);
          return [
            {
              warehouseId: body.fromWarehouseId,
              itemId: line.itemId,
              quantity: quantity.negated(),
              unitCost: out.unitCost,
            },
            {
              warehouseId: body.toWarehouseId,
              itemId: line.itemId,
              quantity,
              unitCost: out.unitCost,
              expiresOn: out.expiresOn,
            },
          ];
        }),
    });
  }

  /**
   * A production order (ADR 0038): makes `quantity` of an item with a bill of materials in one warehouse. Each
   * component goes out at its average cost (bill quantity × quantity ÷ output quantity), and the item comes in at
   * the components' total value ÷ quantity. Refused like any document that would take a component below zero.
   */
  produce(body: ProductionRequest): Promise<StockDocument> {
    const wanted = new Decimal(body.quantity);
    let needs: { itemId: string; quantity: Decimal }[] = [];
    return this.post({
      kind: 'production',
      key: 'inventory.stock.produce',
      warehouseId: body.warehouseId,
      itemIds: [body.itemId],
      prepare: async (tx) => {
        const bill = await tx.bom.findFirst({
          where: { itemId: body.itemId },
          select: { outputQuantity: true, lines: { select: { itemId: true, quantity: true } } },
        });
        if (!bill) throw inventoryErrors.bomNotFound();
        needs = componentNeeds(
          {
            outputQuantity: new Decimal(bill.outputQuantity.toFixed(3)),
            lines: bill.lines.map((l) => ({
              itemId: l.itemId,
              quantity: new Decimal(l.quantity.toFixed(3)),
            })),
          },
          wanted,
        );
        return needs.map((n) => n.itemId);
      },
      header: { note: body.note || null },
      plan: (levels) => {
        const out = needs.map((need) => {
          const booked = bookOut(levels.get(body.warehouseId, need.itemId), need.quantity);
          levels.set(body.warehouseId, need.itemId, booked.level);
          return {
            warehouseId: body.warehouseId,
            itemId: need.itemId,
            quantity: need.quantity.negated(),
            unitCost: booked.unitCost,
          };
        });
        const cost = outputUnitCost(
          out.map((m) => valueOf(m.quantity.negated(), m.unitCost)),
          wanted,
        );
        const made = bookIn(levels.get(body.warehouseId, body.itemId), wanted, cost);
        levels.set(body.warehouseId, body.itemId, made.level);
        return [
          ...out,
          {
            warehouseId: body.warehouseId,
            itemId: body.itemId,
            quantity: wanted,
            unitCost: made.unitCost,
          },
        ];
      },
    });
  }

  async stock(query: StockQuery): Promise<StockLevel[]> {
    const warehouses = await this.readableWarehouses(query);
    if (warehouses.length === 0) return [];
    // Quantities for everyone who reads stock; costs and values only for those who see prices (ADR 0060).
    const prices = await this.seesPrices();
    const rows = await this.db.stockLevel.findMany({
      where: { warehouseId: { in: warehouses } },
      select: {
        warehouseId: true,
        itemId: true,
        quantity: true,
        averageCost: true,
        expiresOn: true,
        item: { select: { name: true, unit: true, minQuantity: true } },
      },
      orderBy: [{ item: { name: 'asc' } }, { itemId: 'asc' }, { warehouseId: 'asc' }],
    });
    return rows.map((row) => {
      const quantity = new Decimal(row.quantity.toFixed(3));
      const averageCost = new Decimal(row.averageCost.toFixed(4));
      const min = row.item.minQuantity ? new Decimal(row.item.minQuantity.toFixed(3)) : null;
      return {
        warehouseId: row.warehouseId,
        itemId: row.itemId,
        itemName: row.item.name,
        unit: row.item.unit,
        quantity: quantityText(quantity),
        averageCost: prices ? costText(averageCost) : null,
        value: prices ? valueOf(quantity, averageCost).toFixed(2) : null,
        low: min !== null && quantity.lte(min),
        expiresOn: quantity.greaterThan(0) ? dateText(row.expiresOn) : null,
      };
    });
  }

  async documents(query: ListStockDocumentsQuery): Promise<StockDocumentSummary[]> {
    const warehouses = await this.readableWarehouses(query);
    if (warehouses.length === 0) return [];
    const rows: DocumentRow[] = await this.db.stockDocument.findMany({
      where: {
        OR: [{ warehouseId: { in: warehouses } }, { toWarehouseId: { in: warehouses } }],
        ...(query.kind ? { kind: query.kind } : {}),
      },
      select: DOCUMENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: DOCUMENT_LIST_LIMIT,
    });
    const prices = await this.seesPrices();
    return rows.map((row) => (prices ? summaryOf(row) : { ...summaryOf(row), value: null }));
  }

  /**
   * A document as the caller may see it (ADR 0060): without unit costs and values unless they hold
   * inventory.prices.read. Audit rows and stored documents keep them.
   */
  async forViewer(document: StockDocument): Promise<StockDocument> {
    if (await this.seesPrices()) return document;
    return {
      ...document,
      value: null,
      lines: document.lines.map((line) => ({ ...line, unitCost: null, value: null })),
    };
  }

  /**
   * Whether the caller sees prices and values (ADR 0060): inventory.prices.read at any of their locations. A member's
   * location limits hold for all of their keys alike, so that is where they read stock too.
   */
  private async seesPrices(): Promise<boolean> {
    const at = await this.access.locationIdsFor('inventory.prices.read');
    return at === 'all' || at.length > 0;
  }

  async document(id: string): Promise<StockDocument> {
    const row: DocumentRow | null = await this.db.stockDocument.findUnique({
      where: { id },
      select: DOCUMENT_SELECT,
    });
    if (!row) throw inventoryErrors.documentNotFound();
    const warehouses = await this.db.warehouse.findMany({
      where: { id: { in: [row.warehouseId, row.toWarehouseId].filter((w): w is string => !!w) } },
      select: { id: true, locationId: true, isTransit: true },
    });
    const readable = await Promise.all(
      warehouses.map((w) => this.canInWarehouse('inventory.stock.read', w)),
    );
    if (!readable.some(Boolean)) throw inventoryErrors.documentNotFound();
    return this.forViewer(documentResponse(row));
  }

  /**
   * An item's activity (its ledger): its movements in the warehouses the caller may read (or the one asked for),
   * newest first, each with the quantity there after it. The balances count back from what is there now; the opening
   * is what was there before the oldest movement shown. Costs only for who sees prices (ADR 0060).
   */
  async itemMovements(itemId: string, query: StockQuery): Promise<ItemMovements> {
    const item = await this.db.stockItem.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!item) throw inventoryErrors.itemNotFound([itemId]);
    const warehouses = await this.readableWarehouses(query);
    if (warehouses.length === 0) {
      return { opening: '0.000', closing: '0.000', truncated: false, movements: [] };
    }
    const [levels, rows] = await Promise.all([
      this.db.stockLevel.findMany({
        where: { itemId, warehouseId: { in: warehouses } },
        select: { quantity: true },
      }),
      this.db.stockMovement.findMany({
        where: { itemId, warehouseId: { in: warehouses } },
        select: {
          id: true,
          createdAt: true,
          warehouseId: true,
          quantity: true,
          unitCost: true,
          warehouse: { select: { name: true } },
          document: {
            select: {
              id: true,
              number: true,
              kind: true,
              reason: true,
              supplier: true,
              note: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ITEM_MOVEMENTS_LIMIT + 1,
      }),
    ]);
    const truncated = rows.length > ITEM_MOVEMENTS_LIMIT;
    const shown = rows.slice(0, ITEM_MOVEMENTS_LIMIT);
    const prices = await this.seesPrices();
    const closing = levels.reduce((sum, l) => sum.plus(l.quantity.toString()), new Decimal(0));
    let balance = closing;
    const movements = shown.map((row) => {
      const quantity = new Decimal(row.quantity.toString());
      const after = balance;
      balance = balance.minus(quantity);
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        documentId: row.document.id,
        documentNumber: row.document.number,
        kind: row.document.kind,
        reason: row.document.reason,
        warehouseId: row.warehouseId,
        warehouseName: row.warehouse.name,
        quantity: quantityText(quantity),
        unitCost: prices ? costText(new Decimal(row.unitCost.toString())) : null,
        remarks: row.document.note ?? row.document.supplier ?? null,
        balance: quantityText(after),
      };
    });
    return {
      opening: quantityText(balance),
      closing: quantityText(closing),
      truncated,
      movements,
    };
  }

  /** Warehouse ids the caller may read, narrowed by the query. */
  private async readableWarehouses(query: { locationId?: string; warehouseId?: string }) {
    const scope = await this.access.locationIdsFor('inventory.stock.read');
    if (scope !== 'all' && scope.length === 0) return [];
    const own = await this.access.warehouseIds();
    const rows = await this.db.warehouse.findMany({
      where: {
        // At their branches, and the warehouses that supply those branches (ADR 0071): read only.
        ...(scope === 'all'
          ? {}
          : {
              OR: [
                { locationId: { in: scope } },
                { isMain: true },
                { suppliesLocationIds: { hasSome: scope } },
              ],
            }),
        // Limited to some warehouses (ADR 0057): those only.
        ...(own ? { id: { in: [...own] } } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.warehouseId ? { id: query.warehouseId } : {}),
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** A warehouse the caller can see and use with `key`, not archived; else 404 / 403. */
  private async usableWarehouse(id: string, key: PermissionKey): Promise<WarehouseRef> {
    const warehouse = await this.db.warehouse.findUnique({
      where: { id },
      select: { id: true, locationId: true, archivedAt: true, isTransit: true },
    });
    if (
      !warehouse ||
      warehouse.archivedAt ||
      !(await this.canInWarehouse('inventory.stock.read', warehouse))
    ) {
      throw inventoryErrors.warehouseNotFound();
    }
    // The transit warehouse is everybody's road between warehouses: its location decides (ADR 0057).
    if (warehouse.isTransit) await this.access.assert(key, { locationId: warehouse.locationId });
    else await this.access.assertAtWarehouse(key, warehouse);
    return { id: warehouse.id, locationId: warehouse.locationId };
  }

  /**
   * `key` for work in a warehouse (ADR 0057): at its location and, for a member limited to some warehouses, one of
   * theirs. The transit warehouse is everybody's road between warehouses: its location decides.
   */
  private canInWarehouse(
    key: PermissionKey,
    warehouse: { id: string; locationId: string; isTransit: boolean },
  ): Promise<boolean> {
    return warehouse.isTransit
      ? this.access.can(key, { locationId: warehouse.locationId })
      : this.access.canAtWarehouse(key, warehouse);
  }

  private async post(input: {
    kind: StockDocumentKind;
    key: PermissionKey;
    warehouseId: string;
    toWarehouseId?: string;
    itemIds: string[];
    /**
     * Reads what the document needs inside its transaction (units, a bill of materials) after the items are
     * checked; returns more item ids to check and lock (a bill's components).
     */
    prepare?: (tx: TenantTransactionClient) => Promise<string[] | void>;
    /** Creates items first, in the same transaction (a vendor invoice's new products, ADR 0049); returns their ids. */
    create?: (tx: TenantTransactionClient) => Promise<string[]>;
    header: { supplier?: string | null; note: string | null; reason?: AdjustmentReason };
    plan: (levels: Levels) => PlannedMovement[];
    /**
     * Runs after the document is booked, in its transaction (a vendor invoice marked approved, ADR 0054); what it
     * returns is what the idempotency key stores, so a replay answers the same.
     */
    complete?: (tx: TenantTransactionClient, document: StockDocument) => Promise<unknown>;
  }): Promise<StockDocument> {
    const { tenantId, userId } = this.tenantContext.require();
    const from = await this.usableWarehouse(input.warehouseId, input.key);
    const to = input.toWarehouseId
      ? await this.usableWarehouse(input.toWarehouseId, input.key)
      : null;
    return this.db.$transaction(async (tx) => {
      if ((await this.settings.get('inventory.valuationMethod', {}, tx)) !== 'weighted_average') {
        throw inventoryErrors.valuationUnsupported();
      }
      if (input.itemIds.length > 0) await usableItems(tx, input.itemIds);
      const created = (await input.create?.(tx)) ?? [];
      const more = (await input.prepare?.(tx)) ?? [];
      const extra = more.filter((id) => !input.itemIds.includes(id));
      if (extra.length > 0) await usableItems(tx, extra);
      const itemIds = [...input.itemIds, ...created, ...extra];

      const warehouses = [from, ...(to ? [to] : [])];
      const levels = await lockLevels(
        tx,
        tenantId,
        warehouses.map((w) => w.id),
        itemIds,
      );
      const movements = input.plan(levels);

      for (const warehouse of warehouses) {
        const allowed = await this.settings.get(
          'inventory.allowNegativeStock',
          { locationId: warehouse.locationId },
          tx,
        );
        if (allowed) continue;
        // Only lines that end below zero and went down: a delivery into a negative level is fine.
        const short = itemIds.filter((itemId) => {
          const after = levels.get(warehouse.id, itemId).quantity;
          return after.isNegative() && after.lessThan(levels.before(warehouse.id, itemId).quantity);
        });
        if (short.length > 0) throw inventoryErrors.insufficientStock(short);
      }

      const response = await this.book(tx, {
        kind: input.kind,
        warehouseId: from.id,
        toWarehouseId: to?.id ?? null,
        reason: input.header.reason ?? null,
        supplier: input.header.supplier ?? null,
        note: input.header.note,
        sourceTicketId: null,
        sourceOrderId: null,
        createdByUserId: userId,
        actor: auditActor.user(userId),
        movements,
        levels,
      });
      const stored = input.complete ? await input.complete(tx, response) : response;
      await this.idempotency.completeInTransaction(tx, stored);
      return response;
    });
  }

  /**
   * Books the ingredients of a kitchen or bar ticket's dishes (docs/modules/inventory.md →
   * Consumption, ADR 0028), in the outbox's transaction: recipe × line quantity out of the
   * warehouse that supplies the ticket's station at its location (else the location's first one);
   * a void puts them back at the current average. Never refused for stock: the sale happened.
   * Nothing for tickets without recipe lines, locations without warehouses, or a ticket already
   * booked (redelivery).
   */
  async consumeTicket(
    tx: TenantTransactionClient,
    payload: EventPayload<'pos.kitchen_ticket.created'>,
  ): Promise<'booked' | 'nothing' | 'no_warehouse'> {
    const { tenantId } = this.tenantContext.require();
    const booked = await tx.stockDocument.findUnique({
      where: { tenantId_sourceTicketId: { tenantId, sourceTicketId: payload.ticketId } },
      select: { id: true },
    });
    if (booked) return 'nothing';
    const recipe = await tx.recipeLine.findMany({
      where: { productId: { in: [...new Set(payload.lines.map((l) => l.productId))] } },
      select: { productId: true, itemId: true, quantity: true },
    });
    const totals = new Map<string, Decimal>();
    for (const line of payload.lines) {
      for (const r of recipe.filter((x) => x.productId === line.productId)) {
        const used = new Decimal(r.quantity.toFixed(3)).times(line.quantity);
        totals.set(r.itemId, (totals.get(r.itemId) ?? new Decimal(0)).plus(used));
      }
    }
    const itemIds = [...totals.keys()].filter((id) => !totals.get(id)!.isZero()).sort();
    if (itemIds.length === 0) return 'nothing';
    const warehouse =
      (await tx.warehouse.findFirst({
        where: {
          locationId: payload.locationId,
          suppliesStation: payload.station,
          archivedAt: null,
        },
        select: { id: true },
      })) ??
      (await tx.warehouse.findFirst({
        where: { locationId: payload.locationId, archivedAt: null },
        select: { id: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }));
    if (!warehouse) return 'no_warehouse';

    const levels = await lockLevels(tx, tenantId, [warehouse.id], itemIds);
    const movements: PlannedMovement[] = itemIds.map((itemId) => {
      const used = totals.get(itemId)!;
      const current = levels.get(warehouse.id, itemId);
      const result = used.isPositive()
        ? bookOut(current, used)
        : bookIn(current, used.negated(), current.averageCost);
      levels.set(warehouse.id, itemId, result.level);
      return {
        warehouseId: warehouse.id,
        itemId,
        quantity: used.negated(),
        unitCost: result.unitCost,
      };
    });
    await this.book(tx, {
      kind: 'consumption',
      warehouseId: warehouse.id,
      toWarehouseId: null,
      reason: null,
      supplier: null,
      note: null,
      sourceTicketId: payload.ticketId,
      sourceOrderId: null,
      createdByUserId: payload.createdByUserId,
      actor: auditActor.system('job.outbox'),
      movements,
      levels,
    });
    return 'booked';
  }

  /**
   * Goods out to a customer (`issue`) or back in (`restock`) for a sales order (docs/modules/orders.md → Step 3, ADR
   * 0044), in the orders module's transaction; the caller checks the order and its keys. An issue goes out at the
   * average cost and is refused below zero unless the location allows negative stock; a restock comes back at the
   * cost the order's goods went out at (else the current average). Lines with nothing to move are skipped; null when
   * none is left.
   */
  async bookForOrder(
    tx: TenantTransactionClient,
    input: {
      kind: 'issue' | 'restock';
      warehouseId: string;
      orderId: string;
      lines: readonly { itemId: string; quantity: string }[];
      userId: string;
    },
  ): Promise<StockDocument | null> {
    const { tenantId } = this.tenantContext.require();
    const totals = new Map<string, Decimal>();
    for (const line of input.lines) {
      const quantity = new Decimal(line.quantity);
      if (quantity.isZero()) continue;
      totals.set(line.itemId, (totals.get(line.itemId) ?? new Decimal(0)).plus(quantity));
    }
    const itemIds = [...totals.keys()].sort();
    if (itemIds.length === 0) return null;
    const warehouse = await tx.warehouse.findUniqueOrThrow({
      where: { id: input.warehouseId },
      select: { id: true, locationId: true },
    });
    const issuedAt = new Map<string, Decimal>();
    if (input.kind === 'restock') {
      const issued = await tx.stockMovement.findMany({
        where: {
          document: { sourceOrderId: input.orderId, kind: 'issue' },
          itemId: { in: itemIds },
        },
        select: { itemId: true, unitCost: true },
        orderBy: { id: 'asc' },
      });
      for (const m of issued) issuedAt.set(m.itemId, new Decimal(m.unitCost.toFixed(4)));
    }
    const levels = await lockLevels(tx, tenantId, [warehouse.id], itemIds);
    const movements: PlannedMovement[] = itemIds.map((itemId) => {
      const quantity = totals.get(itemId)!;
      const current = levels.get(warehouse.id, itemId);
      const booked =
        input.kind === 'issue'
          ? bookOut(current, quantity)
          : bookIn(current, quantity, issuedAt.get(itemId) ?? current.averageCost);
      levels.set(warehouse.id, itemId, booked.level);
      return {
        warehouseId: warehouse.id,
        itemId,
        quantity: input.kind === 'issue' ? quantity.negated() : quantity,
        unitCost: booked.unitCost,
      };
    });
    if (input.kind === 'issue') {
      const allowed = await this.settings.get(
        'inventory.allowNegativeStock',
        { locationId: warehouse.locationId },
        tx,
      );
      const short = itemIds.filter((itemId) =>
        levels.get(warehouse.id, itemId).quantity.isNegative(),
      );
      if (!allowed && short.length > 0) throw inventoryErrors.insufficientStock(short);
    }
    return this.book(tx, {
      kind: input.kind,
      warehouseId: warehouse.id,
      toWarehouseId: null,
      reason: null,
      supplier: null,
      note: null,
      sourceTicketId: null,
      sourceOrderId: input.orderId,
      createdByUserId: input.userId,
      actor: auditActor.user(input.userId),
      movements,
      levels,
    });
  }

  /**
   * Import Data → opening stock (docs/platform/import.md, ADR 0044 step 4): rows of warehouse (name), item (SKU, else
   * name), quantity and unit cost become one receipt per warehouse, all in one transaction. Warehouses must be active and
   * the caller must be able to receive goods at each; unknown names are refused with their rows.
   */
  async importOpeningStock(body: ImportOpeningStockRequest): Promise<DataImportResult> {
    const { tenantId, userId } = this.tenantContext.require();
    const scope = await this.access.locationIdsFor('inventory.stock.receive');
    const own = await this.access.warehouseIds();
    const [warehouses, items] = await Promise.all([
      this.db.warehouse.findMany({
        where: {
          archivedAt: null,
          ...(scope === 'all' ? {} : { locationId: { in: scope } }),
          // Limited to some warehouses (ADR 0057): those only.
          ...(own ? { id: { in: [...own] } } : {}),
        },
        select: { id: true, name: true, locationId: true },
      }),
      this.db.stockItem.findMany({
        where: { archivedAt: null },
        select: {
          id: true,
          name: true,
          sku: true,
          _count: { select: { variants: { where: { archivedAt: null } } } },
        },
      }),
    ]);
    // A parent with variants holds no stock (ADR 0038): it can't be named here.
    const stockable = items.filter((i) => i._count.variants === 0);
    const warehouseByName = new Map(warehouses.map((w) => [w.name.toLowerCase(), w]));
    const itemByKey = new Map<string, string>();
    for (const item of stockable) itemByKey.set(item.name.toLowerCase(), item.id);
    // SKUs win over names when both match.
    for (const item of stockable) if (item.sku) itemByKey.set(item.sku.toLowerCase(), item.id);
    const problems = checkOpeningStockRows(body.rows, {
      warehouses: new Set(warehouseByName.keys()),
      items: new Set(itemByKey.keys()),
    });
    if (problems.length > 0) throw inventoryErrors.importInvalid(problems);

    const groups = new Map<string, { itemId: string; quantity: Decimal; unitCost: Decimal }[]>();
    for (const row of body.rows) {
      const warehouse = warehouseByName.get(row.warehouse.trim().toLowerCase())!;
      const lines = groups.get(warehouse.id) ?? [];
      lines.push({
        itemId: itemByKey.get(row.item.trim().toLowerCase())!,
        quantity: new Decimal(row.quantity.trim()),
        unitCost: new Decimal(row.unitCost.trim()),
      });
      groups.set(warehouse.id, lines);
    }
    return this.db.$transaction(async (tx) => {
      if ((await this.settings.get('inventory.valuationMethod', {}, tx)) !== 'weighted_average') {
        throw inventoryErrors.valuationUnsupported();
      }
      const result: DataImportResult = { created: 0, updated: 0, unchanged: 0, documents: [] };
      // Warehouses in id order, so two imports lock their levels in the same order.
      for (const warehouseId of [...groups.keys()].sort()) {
        const lines = groups.get(warehouseId)!;
        const levels = await lockLevels(
          tx,
          tenantId,
          [warehouseId],
          [...new Set(lines.map((l) => l.itemId))],
        );
        const movements = lines.map((line) => {
          const booked = bookIn(levels.get(warehouseId, line.itemId), line.quantity, line.unitCost);
          levels.set(warehouseId, line.itemId, booked.level);
          return {
            warehouseId,
            itemId: line.itemId,
            quantity: line.quantity,
            unitCost: booked.unitCost,
          };
        });
        const document = await this.book(tx, {
          kind: 'receipt',
          warehouseId,
          toWarehouseId: null,
          reason: null,
          supplier: null,
          note: null,
          sourceTicketId: null,
          sourceOrderId: null,
          createdByUserId: userId,
          actor: auditActor.user(userId),
          movements,
          levels,
        });
        result.created += lines.length;
        result.documents.push(document.number);
      }
      await this.idempotency.completeInTransaction(tx, result);
      return result;
    });
  }

  /**
   * The organization's "In transit" warehouse (ADR 0045), created at `locationId` the first time goods go on the road.
   * Its name is data; the web shows a label for it (`isTransit`).
   */
  async transitWarehouse(tx: TenantTransactionClient, locationId: string): Promise<string> {
    const { tenantId } = this.tenantContext.require();
    const existing = await tx.warehouse.findFirst({
      where: { isTransit: true },
      select: { id: true },
    });
    if (existing) return existing.id;
    await tx.$executeRaw`
      INSERT INTO warehouses (tenant_id, location_id, name, is_transit, sort_order, updated_at)
      VALUES (${tenantId}::uuid, ${locationId}::uuid, 'In transit', true, 1000000, now())
      ON CONFLICT DO NOTHING`;
    const created = await tx.warehouse.findFirstOrThrow({
      where: { isTransit: true },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Goods of a branch stock request (ADR 0045), in the orders module's transaction; the caller checks the request and
   * its keys. `transfer`: out of `fromWarehouseId` at the average cost and into `toWarehouseId` at that cost
   * (refused below zero unless the location allows negative stock, never for the transit warehouse). `shortage`:
   * out of `fromWarehouseId` as an adjustment (goods that never arrived). Lines with nothing to move are skipped;
   * null when none is left.
   */
  async bookForRequest(
    tx: TenantTransactionClient,
    input: {
      kind: 'transfer' | 'shortage';
      fromWarehouseId: string;
      toWarehouseId?: string;
      requestId: string;
      lines: readonly { itemId: string; quantity: string }[];
      userId: string;
    },
  ): Promise<StockDocument | null> {
    const { tenantId } = this.tenantContext.require();
    const totals = new Map<string, Decimal>();
    for (const line of input.lines) {
      const quantity = new Decimal(line.quantity);
      if (quantity.isZero()) continue;
      totals.set(line.itemId, (totals.get(line.itemId) ?? new Decimal(0)).plus(quantity));
    }
    const itemIds = [...totals.keys()].sort();
    if (itemIds.length === 0) return null;
    const from = await tx.warehouse.findUniqueOrThrow({
      where: { id: input.fromWarehouseId },
      select: { id: true, locationId: true, isTransit: true },
    });
    const toId = input.kind === 'transfer' ? input.toWarehouseId! : null;
    const levels = await lockLevels(tx, tenantId, toId ? [from.id, toId] : [from.id], itemIds);
    const movements: PlannedMovement[] = itemIds.flatMap((itemId) => {
      const quantity = totals.get(itemId)!;
      const out = bookOut(levels.get(from.id, itemId), quantity);
      levels.set(from.id, itemId, out.level);
      const moves: PlannedMovement[] = [
        { warehouseId: from.id, itemId, quantity: quantity.negated(), unitCost: out.unitCost },
      ];
      if (toId) {
        const into = bookIn(levels.get(toId, itemId), quantity, out.unitCost, out.expiresOn);
        levels.set(toId, itemId, into.level);
        moves.push({
          warehouseId: toId,
          itemId,
          quantity,
          unitCost: out.unitCost,
          expiresOn: out.expiresOn,
        });
      }
      return moves;
    });
    if (input.kind === 'transfer' && !from.isTransit) {
      const allowed = await this.settings.get(
        'inventory.allowNegativeStock',
        { locationId: from.locationId },
        tx,
      );
      const short = itemIds.filter((itemId) => {
        const after = levels.get(from.id, itemId).quantity;
        return after.isNegative() && after.lessThan(levels.before(from.id, itemId).quantity);
      });
      if (!allowed && short.length > 0) throw inventoryErrors.insufficientStock(short);
    }
    return this.book(tx, {
      kind: input.kind === 'transfer' ? 'transfer' : 'adjustment',
      warehouseId: from.id,
      toWarehouseId: toId,
      reason: input.kind === 'shortage' ? 'other' : null,
      supplier: null,
      note: null,
      sourceTicketId: null,
      sourceOrderId: null,
      sourceRequestId: input.requestId,
      createdByUserId: input.userId,
      actor: auditActor.user(input.userId),
      movements,
      levels,
    });
  }

  /** Numbers and writes a document, its movements and the changed levels, and audits it. */
  private async book(
    tx: TenantTransactionClient,
    input: {
      kind: StockDocumentKind;
      warehouseId: string;
      toWarehouseId: string | null;
      reason: AdjustmentReason | null;
      supplier: string | null;
      note: string | null;
      sourceTicketId: string | null;
      sourceOrderId: string | null;
      /** The branch stock request it was booked for (ADR 0045). */
      sourceRequestId?: string | null;
      createdByUserId: string;
      actor: AuditActor;
      movements: PlannedMovement[];
      levels: Levels;
    },
  ): Promise<StockDocument> {
    const { tenantId } = this.tenantContext.require();
    // As late as possible: the counter row stays locked until commit (ADR 0012).
    const { number } = await this.numbering.next(SERIES[input.kind], tx);
    const document = await tx.stockDocument.create({
      data: {
        tenantId,
        number,
        kind: input.kind,
        warehouseId: input.warehouseId,
        toWarehouseId: input.toWarehouseId,
        reason: input.reason,
        supplier: input.supplier,
        note: input.note,
        sourceTicketId: input.sourceTicketId,
        sourceOrderId: input.sourceOrderId,
        sourceRequestId: input.sourceRequestId ?? null,
        createdByUserId: input.createdByUserId,
      },
      select: { id: true },
    });
    await tx.stockMovement.createMany({
      data: input.movements.map((m) => ({
        tenantId,
        documentId: document.id,
        warehouseId: m.warehouseId,
        itemId: m.itemId,
        quantity: quantityText(m.quantity),
        unitCost: costText(m.unitCost),
        value: valueOf(m.quantity, m.unitCost).toFixed(2),
        expiresOn: m.expiresOn ? new Date(`${m.expiresOn}T00:00:00.000Z`) : null,
      })),
    });
    for (const [warehouseId, itemId, level] of input.levels.entries()) {
      await tx.$executeRaw`
        UPDATE stock_levels
        SET quantity = ${quantityText(level.quantity)}::numeric,
            average_cost = ${costText(level.averageCost)}::numeric,
            expires_on = ${level.expiresOn}::date,
            updated_at = now()
        WHERE warehouse_id = ${warehouseId}::uuid AND item_id = ${itemId}::uuid`;
    }
    await this.notifyLowStock(tx, input.levels);
    const row: DocumentRow = await tx.stockDocument.findUniqueOrThrow({
      where: { id: document.id },
      select: DOCUMENT_SELECT,
    });
    const response = documentResponse(row);
    await this.audit.record(tx, {
      action: 'inventory.stock_document.created',
      actor: input.actor,
      entityId: document.id,
      after: snapshot('stock_document', response),
    });
    return response;
  }

  /**
   * Low stock (ADR 0047): a level that was above the item's reorder level and is now at or below it tells whoever
   * reads stock at that warehouse's branch, once per crossing (not on every sale below it). In transit is skipped.
   */
  private async notifyLowStock(tx: TenantTransactionClient, levels: Levels): Promise<void> {
    const changed = levels.entries();
    if (changed.length === 0) return;
    const [items, warehouses] = await Promise.all([
      tx.stockItem.findMany({
        where: { id: { in: [...new Set(changed.map(([, i]) => i))] }, minQuantity: { not: null } },
        select: { id: true, name: true, minQuantity: true },
      }),
      tx.warehouse.findMany({
        where: { id: { in: [...new Set(changed.map(([w]) => w))] }, isTransit: false },
        select: { id: true, name: true, locationId: true },
      }),
    ]);
    if (items.length === 0 || warehouses.length === 0) return;
    const itemById = new Map(items.map((i) => [i.id, i]));
    const warehouseById = new Map(warehouses.map((w) => [w.id, w]));
    for (const [warehouseId, itemId, level] of changed) {
      const item = itemById.get(itemId);
      const warehouse = warehouseById.get(warehouseId);
      if (!item || !warehouse) continue;
      const min = new Decimal(item.minQuantity!.toFixed(3));
      const was = levels.before(warehouseId, itemId).quantity;
      if (!(was.gt(min) && level.quantity.lte(min))) continue;
      const holders = await this.members.holders(
        asTenantDb(tx),
        'inventory.stock.read',
        warehouse.locationId,
      );
      await this.notifications.notify(
        tx,
        {
          userIds: holders.map((h) => h.userId),
          kind: 'low_stock',
          entityType: 'stock_item',
          entityId: item.id,
          params: {
            item: item.name,
            warehouse: warehouse.name,
            quantity: level.quantity.toDecimalPlaces(3).toString(),
          },
        },
        // The person who booked it hears too: a sale or pick that empties the shelf is easy to miss.
        { actorUserId: null },
      );
    }
  }
}

/**
 * Items a document may move: known, not archived, and without active variants (a parent holds no stock once it has
 * variants, ADR 0038).
 */
async function usableItems(tx: TenantTransactionClient, itemIds: string[]): Promise<void> {
  const items = await tx.stockItem.findMany({
    where: { id: { in: itemIds }, archivedAt: null },
    select: { id: true, _count: { select: { variants: { where: { archivedAt: null } } } } },
  });
  const found = new Map(items.map((i) => [i.id, i]));
  const missing = itemIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw inventoryErrors.itemNotFound(missing);
  const parents = itemIds.filter((id) => found.get(id)!._count.variants > 0);
  if (parents.length > 0) throw inventoryErrors.itemHasVariants(parents);
}

/** The locked levels of a document, keyed by warehouse and item, and which ones it changed. */
interface Levels {
  get(warehouseId: string, itemId: string): Level;
  /** As locked, before this document. */
  before(warehouseId: string, itemId: string): Level;
  set(warehouseId: string, itemId: string, level: Level): void;
  /** The levels this document changed. */
  entries(): [string, string, Level][];
}

/**
 * Creates the missing level rows (0 at 0) and locks every row the document touches, in a fixed
 * order (warehouse, item) so two documents never wait on each other in a cycle.
 */
async function lockLevels(
  tx: TenantTransactionClient,
  tenantId: string,
  warehouseIds: string[],
  itemIds: string[],
): Promise<Levels> {
  const pairs = warehouseIds
    .flatMap((w) => itemIds.map((i) => [w, i] as const))
    .sort(([w1, i1], [w2, i2]) => (w1 === w2 ? i1.localeCompare(i2) : w1.localeCompare(w2)));
  for (const [warehouseId, itemId] of pairs) {
    await tx.$executeRaw`
      INSERT INTO stock_levels (tenant_id, warehouse_id, item_id, quantity, average_cost, updated_at)
      VALUES (${tenantId}::uuid, ${warehouseId}::uuid, ${itemId}::uuid, 0, 0, now())
      ON CONFLICT (tenant_id, warehouse_id, item_id) DO NOTHING`;
  }
  const map = new Map<string, Level>();
  const locked = new Map<string, Level>();
  const touched = new Set<string>();
  for (const [warehouseId, itemId] of pairs) {
    const [row] = await tx.$queryRaw<
      { quantity: string; average_cost: string; expires_on: string | null }[]
    >`
      SELECT quantity::text, average_cost::text, expires_on::text FROM stock_levels
      WHERE warehouse_id = ${warehouseId}::uuid AND item_id = ${itemId}::uuid
      FOR UPDATE`;
    const level = {
      quantity: new Decimal(row!.quantity),
      averageCost: new Decimal(row!.average_cost),
      expiresOn: row!.expires_on,
    };
    map.set(`${warehouseId}:${itemId}`, level);
    locked.set(`${warehouseId}:${itemId}`, level);
  }
  return {
    get: (w, i) => map.get(`${w}:${i}`)!,
    before: (w, i) => locked.get(`${w}:${i}`)!,
    set: (w, i, level) => {
      map.set(`${w}:${i}`, level);
      touched.add(`${w}:${i}`);
    },
    entries: () =>
      [...touched].map((key) => {
        const [w, i] = key.split(':') as [string, string];
        return [w, i, map.get(key)!];
      }),
  };
}

function summaryOf(row: DocumentRow): StockDocumentSummary {
  const value = row.movements
    .filter((m) => m.warehouseId === row.warehouseId)
    .reduce((sum, m) => sum.plus(m.value.toFixed(2)), new Decimal(0));
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse.name,
    toWarehouseId: row.toWarehouseId,
    toWarehouseName: row.toWarehouse?.name ?? null,
    reason: row.reason,
    supplier: row.supplier,
    note: row.note,
    lineCount: new Set(row.movements.map((m) => m.itemId)).size,
    value: value.toFixed(2),
    createdAt: row.createdAt.toISOString(),
  };
}

function documentResponse(row: DocumentRow): StockDocument {
  return {
    ...summaryOf(row),
    lines: row.movements.map((m) => ({
      id: m.id,
      warehouseId: m.warehouseId,
      itemId: m.itemId,
      itemName: m.item.name,
      unit: m.item.unit,
      quantity: m.quantity.toFixed(3),
      unitCost: m.unitCost.toFixed(4),
      value: m.value.toFixed(2),
      expiresOn: dateText(m.expiresOn),
    })),
  };
}
