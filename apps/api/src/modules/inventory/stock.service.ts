import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type {
  AdjustmentReason,
  AdjustmentRequest,
  ListStockDocumentsQuery,
  NumberSeriesKey,
  PermissionKey,
  ReceiptRequest,
  StockDocument,
  StockDocumentKind,
  StockDocumentSummary,
  StockLevel,
  StockQuery,
  StockUnit,
  TransferRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { SettingsService } from '../../platform/config/settings';
import { IdempotencyService } from '../../platform/idempotency';
import { NumberingService } from '../../platform/numbering';
import { AccessService } from '../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { inventoryErrors } from './inventory-errors';
import { bookIn, bookOut, costText, type Level, quantityText, valueOf } from './valuation';

/** Prisma returns `numeric` columns as Decimal objects; only their exact text is used here. */
type DecimalValue = { toFixed(digits: number): string };

const SERIES: Record<StockDocumentKind, NumberSeriesKey> = {
  receipt: 'inventory.goodsReceipt',
  adjustment: 'inventory.stockAdjustment',
  transfer: 'inventory.stockTransfer',
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
    item: { name: string; unit: StockUnit };
  }[];
}

/** One movement to write: signed quantity in a warehouse. */
interface PlannedMovement {
  warehouseId: string;
  itemId: string;
  quantity: Decimal;
  unitCost: Decimal;
}

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
  ) {}

  receive(body: ReceiptRequest): Promise<StockDocument> {
    return this.post({
      kind: 'receipt',
      key: 'inventory.stock.receive',
      warehouseId: body.warehouseId,
      itemIds: body.lines.map((l) => l.itemId),
      header: { supplier: body.supplier ?? null, note: body.note || null },
      plan: (levels) =>
        body.lines.map((line) => {
          const quantity = new Decimal(line.quantity);
          const booked = bookIn(
            levels.get(body.warehouseId, line.itemId),
            quantity,
            new Decimal(line.unitCost),
          );
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
          // The stock brings its cost along, like a receipt at the source's average.
          const into = bookIn(levels.get(body.toWarehouseId, line.itemId), quantity, out.unitCost);
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
            },
          ];
        }),
    });
  }

  async stock(query: StockQuery): Promise<StockLevel[]> {
    const warehouses = await this.readableWarehouses(query);
    if (warehouses.length === 0) return [];
    const rows = await this.db.stockLevel.findMany({
      where: { warehouseId: { in: warehouses } },
      select: {
        warehouseId: true,
        itemId: true,
        quantity: true,
        averageCost: true,
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
        averageCost: costText(averageCost),
        value: valueOf(quantity, averageCost).toFixed(2),
        low: min !== null && quantity.lte(min),
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
    return rows.map(summaryOf);
  }

  async document(id: string): Promise<StockDocument> {
    const row: DocumentRow | null = await this.db.stockDocument.findUnique({
      where: { id },
      select: DOCUMENT_SELECT,
    });
    if (!row) throw inventoryErrors.documentNotFound();
    const warehouses = await this.db.warehouse.findMany({
      where: { id: { in: [row.warehouseId, row.toWarehouseId].filter((w): w is string => !!w) } },
      select: { locationId: true },
    });
    const readable = await Promise.all(
      warehouses.map((w) => this.access.can('inventory.stock.read', { locationId: w.locationId })),
    );
    if (!readable.some(Boolean)) throw inventoryErrors.documentNotFound();
    return documentResponse(row);
  }

  /** Warehouse ids the caller may read, narrowed by the query. */
  private async readableWarehouses(query: { locationId?: string; warehouseId?: string }) {
    const scope = await this.access.locationIdsFor('inventory.stock.read');
    if (scope !== 'all' && scope.length === 0) return [];
    const rows = await this.db.warehouse.findMany({
      where: {
        ...(scope === 'all' ? {} : { locationId: { in: scope } }),
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
      select: { id: true, locationId: true, archivedAt: true },
    });
    if (
      !warehouse ||
      warehouse.archivedAt ||
      !(await this.access.can('inventory.stock.read', { locationId: warehouse.locationId }))
    ) {
      throw inventoryErrors.warehouseNotFound();
    }
    await this.access.assert(key, { locationId: warehouse.locationId });
    return warehouse;
  }

  private async post(input: {
    kind: StockDocumentKind;
    key: PermissionKey;
    warehouseId: string;
    toWarehouseId?: string;
    itemIds: string[];
    header: { supplier?: string | null; note: string | null; reason?: AdjustmentReason };
    plan: (levels: Levels) => PlannedMovement[];
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
      const items = await tx.stockItem.findMany({
        where: { id: { in: input.itemIds }, archivedAt: null },
        select: { id: true },
      });
      const found = new Set(items.map((i) => i.id));
      const missing = input.itemIds.filter((id) => !found.has(id));
      if (missing.length > 0) throw inventoryErrors.itemNotFound(missing);

      const warehouses = [from, ...(to ? [to] : [])];
      const levels = await lockLevels(
        tx,
        tenantId,
        warehouses.map((w) => w.id),
        input.itemIds,
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
        const short = input.itemIds.filter((itemId) => {
          const after = levels.get(warehouse.id, itemId).quantity;
          return after.isNegative() && after.lessThan(levels.before(warehouse.id, itemId).quantity);
        });
        if (short.length > 0) throw inventoryErrors.insufficientStock(short);
      }

      // As late as possible: the counter row stays locked until commit (ADR 0012).
      const { number } = await this.numbering.next(SERIES[input.kind], tx);
      const document = await tx.stockDocument.create({
        data: {
          tenantId,
          number,
          kind: input.kind,
          warehouseId: from.id,
          toWarehouseId: to?.id ?? null,
          reason: input.header.reason ?? null,
          supplier: input.header.supplier ?? null,
          note: input.header.note,
          createdByUserId: userId,
        },
        select: { id: true },
      });
      await tx.stockMovement.createMany({
        data: movements.map((m) => ({
          tenantId,
          documentId: document.id,
          warehouseId: m.warehouseId,
          itemId: m.itemId,
          quantity: quantityText(m.quantity),
          unitCost: costText(m.unitCost),
          value: valueOf(m.quantity, m.unitCost).toFixed(2),
        })),
      });
      for (const [warehouseId, itemId, level] of levels.entries()) {
        await tx.$executeRaw`
          UPDATE stock_levels
          SET quantity = ${quantityText(level.quantity)}::numeric,
              average_cost = ${costText(level.averageCost)}::numeric,
              updated_at = now()
          WHERE warehouse_id = ${warehouseId}::uuid AND item_id = ${itemId}::uuid`;
      }
      const row: DocumentRow = await tx.stockDocument.findUniqueOrThrow({
        where: { id: document.id },
        select: DOCUMENT_SELECT,
      });
      const response = documentResponse(row);
      await this.audit.record(tx, {
        action: 'inventory.stock_document.created',
        actor: auditActor.user(userId),
        entityId: document.id,
        after: snapshot('stock_document', response),
      });
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }
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
    const [row] = await tx.$queryRaw<{ quantity: string; average_cost: string }[]>`
      SELECT quantity::text, average_cost::text FROM stock_levels
      WHERE warehouse_id = ${warehouseId}::uuid AND item_id = ${itemId}::uuid
      FOR UPDATE`;
    const level = {
      quantity: new Decimal(row!.quantity),
      averageCost: new Decimal(row!.average_cost),
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
    })),
  };
}
