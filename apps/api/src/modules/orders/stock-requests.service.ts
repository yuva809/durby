import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type {
  ApproveStockRequest,
  CreateStockRequest,
  ListStockRequestsQuery,
  PackStockRequest,
  ReceiveStockRequest,
  RequestAvailability,
  RequestDriver,
  RequestWarehouse,
  StockRequest,
  StockRequestNote,
  StockRequestStatus,
  StockRequestSummary,
  StockUnit,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { NumberingService } from '../../platform/numbering';
import { AccessService, MemberNames } from '../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { StockService } from '../inventory';
import { ordersErrors } from './orders-errors';

type Qty = { toFixed(digits: number): string };

const SUMMARY_SELECT = {
  id: true,
  number: true,
  transferNumber: true,
  status: true,
  locationId: true,
  fromLocationId: true,
  fromWarehouseId: true,
  toWarehouseId: true,
  driverUserId: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { name: true } },
  fromWarehouse: { select: { name: true, location: { select: { name: true } } } },
  toWarehouse: { select: { name: true } },
  _count: { select: { lines: true } },
} as const;

const REQUEST_SELECT = {
  ...SUMMARY_SELECT,
  note: true,
  lines: {
    select: {
      id: true,
      itemId: true,
      quantity: true,
      approvedQuantity: true,
      pickedQuantity: true,
      receivedQuantity: true,
      item: { select: { name: true, unit: true } },
    },
    orderBy: { sortOrder: 'asc' },
  },
  events: {
    select: { id: true, status: true, note: true, userId: true, createdAt: true },
    orderBy: { id: 'asc' },
  },
} as const;

interface SummaryRow {
  id: string;
  number: string;
  transferNumber: string | null;
  status: StockRequestStatus;
  locationId: string;
  fromLocationId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  driverUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  location: { name: string };
  fromWarehouse: { name: string; location: { name: string } };
  toWarehouse: { name: string };
  _count: { lines: number };
}

interface RequestRow extends SummaryRow {
  note: string | null;
  lines: {
    id: string;
    itemId: string;
    quantity: Qty;
    approvedQuantity: Qty | null;
    pickedQuantity: Qty | null;
    receivedQuantity: Qty | null;
    item: { name: string; unit: StockUnit };
  }[];
  events: {
    id: string;
    status: StockRequestStatus;
    note: string | null;
    userId: string | null;
    createdAt: Date;
  }[];
}

/** Where each status may go next (ADR 0045); received, rejected and cancelled are final. */
const NEXT: Readonly<Record<StockRequestStatus, readonly StockRequestStatus[]>> = {
  submitted: ['approved', 'rejected', 'cancelled'],
  approved: ['picking', 'packed'],
  picking: ['packed'],
  // The branch may confirm the goods even if the driver didn't tap "picked up" or "delivered".
  packed: ['in_transit', 'received'],
  in_transit: ['delivered', 'received'],
  delivered: ['received'],
  received: [],
  rejected: [],
  cancelled: [],
};

export const canMoveRequest = (from: StockRequestStatus, to: StockRequestStatus): boolean =>
  NEXT[from].includes(to);

const LIST_LIMIT = 200;

/**
 * Branch stock requests (docs/modules/orders.md → Branch requests, ADR 0045). A branch (orders.requests.create at its
 * location) asks a warehouse for items; an owner or admin (orders.requests.approve) approves with the quantities to
 * send, which gives the transfer its number, or rejects; the warehouse (orders.picking.use at the source) picks and
 * packs, which moves the goods into "In transit"; a driver (assigned, orders.delivery.use) picks up and delivers;
 * the branch (orders.requests.receive) confirms what arrived, which moves it into the branch and books the rest as
 * short. Every step: row lock, timeline row, audit row, idempotency key completed in the transaction.
 */
@Injectable()
export class StockRequestsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly numbering: NumberingService,
    private readonly stock: StockService,
    private readonly members: MemberNames,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------------------------

  async list(query: ListStockRequestsQuery): Promise<StockRequestSummary[]> {
    const { userId } = this.tenantContext.require();
    const statusWhere = query.status ? { status: { in: query.status } } : {};
    let where: object;
    if (query.mine) {
      where = { ...statusWhere, driverUserId: userId };
    } else if (await this.access.can('orders.requests.approve')) {
      where = statusWhere;
    } else {
      const read = await this.access.locationIdsFor('orders.requests.read');
      const assign = await this.access.locationIdsFor('orders.delivery.assign');
      if (read === 'all' || assign === 'all') {
        where = statusWhere;
      } else {
        const branches = read;
        const sources = [...new Set([...read, ...assign])];
        if (branches.length === 0 && sources.length === 0) return [];
        where = {
          ...statusWhere,
          OR: [{ locationId: { in: branches } }, { fromLocationId: { in: sources } }],
        };
      }
    }
    const rows: SummaryRow[] = await this.db.stockRequest.findMany({
      where,
      select: SUMMARY_SELECT,
      orderBy: { id: 'desc' },
      take: LIST_LIMIT,
    });
    const names = await this.members.forUsers(
      asTenantDb(this.db),
      rows.flatMap((r) => (r.driverUserId ? [r.driverUserId] : [])),
    );
    return rows.map((r) => summaryResponse(r, names));
  }

  async get(id: string): Promise<StockRequest> {
    const row = await this.readable(id);
    const names = await this.members.forUsers(asTenantDb(this.db), driverIds(row));
    return requestResponse(row, names);
  }

  /** Every active warehouse a request can name (never the transit one), and where the caller may request into. */
  async warehouses(): Promise<RequestWarehouse[]> {
    const rows = await this.db.warehouse.findMany({
      where: { archivedAt: null, isTransit: false },
      select: { id: true, name: true, locationId: true, location: { select: { name: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const scope = await this.access.locationIdsFor('orders.requests.create');
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      locationId: w.locationId,
      locationName: w.location.name,
      canRequestInto: scope === 'all' || scope.includes(w.locationId),
    }));
  }

  /**
   * What a warehouse has, for the request form: every active item that holds stock itself, with its quantity there
   * (0 when none). Quantities only, no costs; for those who can request somewhere.
   */
  async availability(warehouseId: string): Promise<RequestAvailability[]> {
    const warehouse = await this.db.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true, archivedAt: true, isTransit: true },
    });
    if (!warehouse || warehouse.archivedAt || warehouse.isTransit) {
      throw ordersErrors.warehouseNotFound();
    }
    const [items, levels] = await Promise.all([
      this.db.stockItem.findMany({
        where: { archivedAt: null },
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          parentItemId: true,
          variantValues: true,
          _count: { select: { variants: { where: { archivedAt: null } } } },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.db.stockLevel.findMany({
        where: { warehouseId },
        select: { itemId: true, quantity: true },
      }),
    ]);
    const quantity = new Map(levels.map((l) => [l.itemId, l.quantity.toFixed(3)]));
    const names = new Map(items.map((i) => [i.id, i.name]));
    return items
      .filter((i) => i._count.variants === 0)
      .map((i) => ({
        itemId: i.id,
        itemName:
          i.parentItemId && i.variantValues.length > 0
            ? `${names.get(i.parentItemId) ?? i.name} · ${i.variantValues.join(' / ')}`
            : i.name,
        sku: i.sku,
        unit: i.unit,
        available: quantity.get(i.id) ?? '0.000',
      }));
  }

  /** Who can drive for a request's source warehouse (orders.delivery.use there). */
  async drivers(warehouseId: string): Promise<RequestDriver[]> {
    const warehouse = await this.db.warehouse.findUnique({
      where: { id: warehouseId },
      select: { locationId: true },
    });
    if (!warehouse) throw ordersErrors.warehouseNotFound();
    await this.access.assert('orders.delivery.assign', { locationId: warehouse.locationId });
    const holders = await this.members.holders(
      asTenantDb(this.db),
      'orders.delivery.use',
      warehouse.locationId,
    );
    return holders.map((h) => ({ userId: h.userId, name: h.name ?? '' }));
  }

  // -------------------------------------------------------------------------------------------------------------
  // The branch
  // -------------------------------------------------------------------------------------------------------------

  async create(body: CreateStockRequest): Promise<StockRequest> {
    const { tenantId, userId } = this.tenantContext.require();
    if (body.fromWarehouseId === body.toWarehouseId) throw ordersErrors.requestInvalid();
    const [from, to] = await Promise.all([
      this.db.warehouse.findUnique({
        where: { id: body.fromWarehouseId },
        select: { id: true, locationId: true, archivedAt: true, isTransit: true },
      }),
      this.db.warehouse.findUnique({
        where: { id: body.toWarehouseId },
        select: { id: true, locationId: true, archivedAt: true, isTransit: true },
      }),
    ]);
    if (!from || from.archivedAt || from.isTransit || !to || to.archivedAt || to.isTransit) {
      throw ordersErrors.warehouseNotFound();
    }
    await this.access.assert('orders.requests.create', { locationId: to.locationId });
    return this.db.$transaction(async (tx) => {
      const ids = body.lines.map((l) => l.itemId);
      const items = await tx.stockItem.findMany({
        where: { id: { in: ids }, archivedAt: null },
        select: { id: true, _count: { select: { variants: { where: { archivedAt: null } } } } },
      });
      const usable = new Set(items.filter((i) => i._count.variants === 0).map((i) => i.id));
      const missing = ids.filter((id) => !usable.has(id));
      if (missing.length > 0) throw ordersErrors.itemNotFound(missing);
      const { number } = await this.numbering.next('orders.stockRequest', tx);
      const request = await tx.stockRequest.create({
        data: {
          tenantId,
          number,
          locationId: to.locationId,
          fromLocationId: from.locationId,
          fromWarehouseId: from.id,
          toWarehouseId: to.id,
          note: body.note ?? null,
          requestedByUserId: userId,
        },
        select: { id: true },
      });
      await tx.stockRequestLine.createMany({
        data: body.lines.map((l, i) => ({
          tenantId,
          requestId: request.id,
          itemId: l.itemId,
          quantity: new Decimal(l.quantity).toFixed(3),
          sortOrder: i,
        })),
      });
      await tx.stockRequestEvent.create({
        data: {
          tenantId,
          requestId: request.id,
          status: 'submitted',
          note: body.note ?? null,
          userId,
        },
      });
      const response = await this.read(tx, request.id);
      await this.audit.record(tx, {
        action: 'orders.stock_request.created',
        actor: auditActor.user(userId),
        entityId: request.id,
        after: requestSnapshot(response),
      });
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  cancel(id: string, body: StockRequestNote): Promise<StockRequest> {
    return this.move(id, 'cancelled', body.note ?? null, (row) =>
      this.access.assert('orders.requests.create', { locationId: row.locationId }),
    );
  }

  /** What arrived (at most what was packed); goods move from In transit into the branch, the rest is booked short. */
  receive(id: string, body: ReceiveStockRequest): Promise<StockRequest> {
    const { userId } = this.tenantContext.require();
    return this.move(
      id,
      'received',
      body.note ?? null,
      (row) => this.access.assert('orders.requests.receive', { locationId: row.locationId }),
      async (tx, row) => {
        const sent = row.lines.filter((l) => l.pickedQuantity && !isZero(l.pickedQuantity));
        const received = quantitiesFor(sent, body.lines, (l) => l.pickedQuantity!);
        for (const line of row.lines) {
          await tx.stockRequestLine.update({
            where: { id: line.id },
            data: { receivedQuantity: received.get(line.id) ?? '0.000' },
          });
        }
        const transit = await this.stock.transitWarehouse(tx, row.fromLocationId);
        await this.stock.bookForRequest(tx, {
          kind: 'transfer',
          fromWarehouseId: transit,
          toWarehouseId: row.toWarehouseId,
          requestId: row.id,
          lines: sent.map((l) => ({ itemId: l.itemId, quantity: received.get(l.id)! })),
          userId,
        });
        await this.stock.bookForRequest(tx, {
          kind: 'shortage',
          fromWarehouseId: transit,
          requestId: row.id,
          lines: sent.map((l) => ({
            itemId: l.itemId,
            quantity: new Decimal(l.pickedQuantity!.toFixed(3))
              .minus(received.get(l.id)!)
              .toFixed(3),
          })),
          userId,
        });
      },
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // The owner or admin
  // -------------------------------------------------------------------------------------------------------------

  /** The quantity to send per line (0 drops it, at least one above 0); the request becomes transfer TRF-…. */
  approve(id: string, body: ApproveStockRequest): Promise<StockRequest> {
    return this.move(
      id,
      'approved',
      body.note ?? null,
      () => this.access.assert('orders.requests.approve'),
      async (tx, row) => {
        const approved = quantitiesFor(row.lines, body.lines, null);
        if ([...approved.values()].every((q) => new Decimal(q).isZero())) {
          throw ordersErrors.requestInvalid();
        }
        for (const line of row.lines) {
          await tx.stockRequestLine.update({
            where: { id: line.id },
            data: { approvedQuantity: approved.get(line.id)! },
          });
        }
        const { number } = await this.numbering.next('orders.stockTransfer', tx);
        return { transferNumber: number };
      },
    );
  }

  reject(id: string, body: StockRequestNote): Promise<StockRequest> {
    return this.move(id, 'rejected', body.note ?? null, () =>
      this.access.assert('orders.requests.approve'),
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // The warehouse
  // -------------------------------------------------------------------------------------------------------------

  startPicking(id: string): Promise<StockRequest> {
    return this.move(id, 'picking', null, (row) =>
      this.access.assert('orders.picking.use', { locationId: row.fromLocationId }),
    );
  }

  /** What was picked (at most what was approved); the goods move into In transit, optionally with a driver. */
  pack(id: string, body: PackStockRequest): Promise<StockRequest> {
    const { userId } = this.tenantContext.require();
    return this.move(
      id,
      'packed',
      null,
      async (row) => {
        await this.access.assert('orders.picking.use', { locationId: row.fromLocationId });
        if (body.driverUserId) {
          await this.access.assert('orders.delivery.assign', { locationId: row.fromLocationId });
        }
      },
      async (tx, row) => {
        const toSend = row.lines.filter((l) => l.approvedQuantity && !isZero(l.approvedQuantity));
        const picked = quantitiesFor(toSend, body.lines, (l) => l.approvedQuantity!);
        for (const line of row.lines) {
          await tx.stockRequestLine.update({
            where: { id: line.id },
            data: { pickedQuantity: picked.get(line.id) ?? '0.000' },
          });
        }
        if (body.driverUserId) await this.assertDriver(tx, row.fromLocationId, body.driverUserId);
        const transit = await this.stock.transitWarehouse(tx, row.fromLocationId);
        await this.stock.bookForRequest(tx, {
          kind: 'transfer',
          fromWarehouseId: row.fromWarehouseId,
          toWarehouseId: transit,
          requestId: row.id,
          lines: toSend.map((l) => ({ itemId: l.itemId, quantity: picked.get(l.id)! })),
          userId,
        });
        return body.driverUserId ? { driverUserId: body.driverUserId } : {};
      },
    );
  }

  /** Who drives it; while it is packed or on the road. */
  async assignDriver(id: string, driverUserId: string): Promise<StockRequest> {
    const { userId } = this.tenantContext.require();
    const row = await this.readable(id);
    await this.access.assert('orders.delivery.assign', { locationId: row.fromLocationId });
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await this.read(tx, id);
      if (!['packed', 'in_transit'].includes(before.status)) {
        throw ordersErrors.requestTransition(before.status, before.status);
      }
      await this.assertDriver(tx, row.fromLocationId, driverUserId);
      await tx.stockRequest.update({ where: { id }, data: { driverUserId } });
      const after = await this.read(tx, id);
      await this.audit.record(tx, {
        action: 'orders.stock_request.status_changed',
        actor: auditActor.user(userId),
        entityId: id,
        before: requestSnapshot(before),
        after: requestSnapshot(after),
      });
      await this.idempotency.completeInTransaction(tx, after);
      return after;
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The driver
  // -------------------------------------------------------------------------------------------------------------

  pickUp(id: string): Promise<StockRequest> {
    return this.move(id, 'in_transit', null, (row) => this.assertDriving(row));
  }

  deliver(id: string, body: StockRequestNote): Promise<StockRequest> {
    return this.move(id, 'delivered', body.note ?? null, (row) => this.assertDriving(row));
  }

  // -------------------------------------------------------------------------------------------------------------

  /** The assigned driver (holding orders.delivery.use somewhere), or someone who assigns drivers at the source. */
  private async assertDriving(row: { driverUserId: string | null; fromLocationId: string }) {
    const { userId } = this.tenantContext.require();
    if (await this.access.can('orders.delivery.assign', { locationId: row.fromLocationId })) return;
    const driving = await this.access.locationIdsFor('orders.delivery.use');
    const holdsUse = driving === 'all' || driving.length > 0;
    if (!holdsUse || row.driverUserId !== userId) throw ordersErrors.requestNotYours();
  }

  private async assertDriver(tx: TenantTransactionClient, locationId: string, userId: string) {
    const holders = await this.members.holders(asTenantDb(tx), 'orders.delivery.use', locationId);
    if (!holders.some((h) => h.userId === userId)) throw ordersErrors.driverNotFound();
  }

  /** The request if the caller may see it (branch, source warehouse, approver, its driver); else 404. */
  private async readable(id: string): Promise<RequestRow> {
    const { userId } = this.tenantContext.require();
    const row: RequestRow | null = await this.db.stockRequest.findUnique({
      where: { id },
      select: REQUEST_SELECT,
    });
    if (!row) throw ordersErrors.requestNotFound();
    const visible =
      row.driverUserId === userId ||
      (await this.access.can('orders.requests.approve')) ||
      (await this.access.can('orders.requests.read', { locationId: row.locationId })) ||
      (await this.access.can('orders.requests.read', { locationId: row.fromLocationId })) ||
      (await this.access.can('orders.delivery.assign', { locationId: row.fromLocationId }));
    if (!visible) throw ordersErrors.requestNotFound();
    return row;
  }

  /**
   * A status step: checks visibility and `allowed` first, then under a row lock checks the move, runs `apply` (lines,
   * stock) and writes the status with the columns it returns, a timeline row and an audit row.
   */
  private async move(
    id: string,
    to: StockRequestStatus,
    note: string | null,
    allowed: (row: RequestRow) => Promise<void>,
    apply?: (
      tx: TenantTransactionClient,
      row: RequestRow,
    ) => Promise<{ transferNumber?: string; driverUserId?: string } | void>,
  ): Promise<StockRequest> {
    const { tenantId, userId } = this.tenantContext.require();
    await allowed(await this.readable(id));
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const row: RequestRow = await tx.stockRequest.findUniqueOrThrow({
        where: { id },
        select: REQUEST_SELECT,
      });
      const before = requestResponse(row, new Map());
      if (!canMoveRequest(row.status, to)) throw ordersErrors.requestTransition(row.status, to);
      const extra = (await apply?.(tx, row)) ?? {};
      await tx.stockRequest.update({ where: { id }, data: { status: to, ...extra } });
      await tx.stockRequestEvent.create({
        data: { tenantId, requestId: id, status: to, note, userId },
      });
      const after = await this.read(tx, id);
      await this.audit.record(tx, {
        action: 'orders.stock_request.status_changed',
        actor: auditActor.user(userId),
        entityId: id,
        before: requestSnapshot(before),
        after: requestSnapshot(after),
      });
      await this.idempotency.completeInTransaction(tx, after);
      return after;
    });
  }

  private async read(tx: TenantTransactionClient, id: string): Promise<StockRequest> {
    const row: RequestRow = await tx.stockRequest.findUniqueOrThrow({
      where: { id },
      select: REQUEST_SELECT,
    });
    const names = await this.members.forUsers(asTenantDb(tx), driverIds(row));
    return requestResponse(row, names);
  }
}

const isZero = (q: Qty) => new Decimal(q.toFixed(3)).isZero();

const driverIds = (row: { driverUserId: string | null }) =>
  row.driverUserId ? [row.driverUserId] : [];

/**
 * Per-line quantities from a body that names `lines` exactly once each; `max` caps each (null: no cap). Refused as
 * `orders.request_invalid` when a line is missing, unknown or over its cap.
 */
function quantitiesFor<L extends { id: string }>(
  lines: readonly L[],
  given: readonly { lineId: string; quantity: string }[],
  max: ((line: L) => Qty) | null,
): Map<string, string> {
  const byId = new Map(given.map((g) => [g.lineId, g.quantity]));
  if (byId.size !== lines.length || lines.some((l) => !byId.has(l.id))) {
    throw ordersErrors.requestInvalid();
  }
  const out = new Map<string, string>();
  for (const line of lines) {
    const quantity = new Decimal(byId.get(line.id)!);
    if (max && quantity.greaterThan(max(line).toFixed(3))) throw ordersErrors.requestInvalid();
    out.set(line.id, quantity.toFixed(3));
  }
  return out;
}

const requestSnapshot = (r: StockRequest) => snapshot('stock_request', r);

function summaryResponse(row: SummaryRow, names: ReadonlyMap<string, string>): StockRequestSummary {
  return {
    id: row.id,
    number: row.number,
    transferNumber: row.transferNumber,
    status: row.status,
    fromWarehouseId: row.fromWarehouseId,
    fromWarehouseName: row.fromWarehouse.name,
    fromLocationName: row.fromWarehouse.location.name,
    toWarehouseId: row.toWarehouseId,
    toWarehouseName: row.toWarehouse.name,
    locationId: row.locationId,
    locationName: row.location.name,
    lineCount: row._count.lines,
    driverUserId: row.driverUserId,
    driverName: row.driverUserId ? (names.get(row.driverUserId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requestResponse(row: RequestRow, names: ReadonlyMap<string, string>): StockRequest {
  const q = (v: Qty | null) => v?.toFixed(3) ?? null;
  return {
    ...summaryResponse(row, names),
    note: row.note,
    lines: row.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      itemName: l.item.name,
      unit: l.item.unit,
      quantity: l.quantity.toFixed(3),
      approvedQuantity: q(l.approvedQuantity),
      pickedQuantity: q(l.pickedQuantity),
      receivedQuantity: q(l.receivedQuantity),
    })),
    events: row.events.map((e) => ({
      id: e.id,
      status: e.status,
      note: e.note,
      userId: e.userId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
