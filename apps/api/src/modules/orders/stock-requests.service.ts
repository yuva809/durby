import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type {
  ApproveStockRequest,
  CreateStockRequest,
  ListStockRequestsQuery,
  NotificationKind,
  PackStockRequest,
  PermissionKey,
  ReceiveStockRequest,
  RequestAvailability,
  RequestDestination,
  RequestDriver,
  RequestWarehouse,
  StockRequest,
  StockRequestNote,
  StockRequestStatus,
  StockRequestSummary,
  StockUnit,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { EntitlementService } from '../../platform/config/entitlements';
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
  requestedByUserId: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { name: true, address: true } },
  fromWarehouse: { select: { name: true, location: { select: { name: true, address: true } } } },
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
  requestedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  location: { name: string; address: string | null };
  fromWarehouse: { name: string; location: { name: string; address: string | null } };
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
    private readonly notifications: NotificationService,
    private readonly entitlements: EntitlementService,
    private readonly settings: SettingsService,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------------------------

  async list(query: ListStockRequestsQuery): Promise<StockRequestSummary[]> {
    const { userId } = this.tenantContext.require();
    // The reads are @Authenticated() (no feature guard): without `orders` there is nothing to list.
    if (!(await this.entitlements.isEnabled('orders'))) return [];
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
    // Limited to some warehouses (ADR 0057): the requests going out of or into them (a branch's own still show).
    const own = query.mine ? null : await this.access.warehouseIds();
    if (own) {
      where = {
        AND: [
          where,
          { OR: [{ fromWarehouseId: { in: [...own] } }, { toWarehouseId: { in: [...own] } }] },
        ],
      };
    }
    const rows: SummaryRow[] = await this.db.stockRequest.findMany({
      where,
      select: SUMMARY_SELECT,
      orderBy: { id: 'desc' },
      take: LIST_LIMIT,
    });
    const names = await this.members.forUsers(asTenantDb(this.db), [
      ...new Set(rows.flatMap(namedUsers)),
    ]);
    return rows.map((r) => summaryResponse(r, names));
  }

  async get(id: string): Promise<StockRequest> {
    if (!(await this.entitlements.isEnabled('orders'))) throw ordersErrors.requestNotFound();
    const row = await this.readable(id);
    const names = await this.members.forUsers(asTenantDb(this.db), namedUsers(row));
    return requestResponse(row, names);
  }

  /** Every active warehouse a request can name (never the transit one), and where the caller may request into. */
  async warehouses(): Promise<RequestWarehouse[]> {
    const rows = await this.db.warehouse.findMany({
      where: { archivedAt: null, isTransit: false },
      select: {
        id: true,
        name: true,
        locationId: true,
        isMain: true,
        location: { select: { name: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const scope = await this.access.locationIdsFor('orders.requests.create');
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      locationId: w.locationId,
      locationName: w.location.name,
      canRequestInto: scope === 'all' || scope.includes(w.locationId),
      isMain: w.isMain,
    }));
  }

  /**
   * The branches the caller may request goods for (ADR 0053), each with the warehouse goods go into: its first
   * active one, or none yet (the first request creates its store). The main warehouse's own location is not a branch.
   */
  async destinations(): Promise<RequestDestination[]> {
    const scope = await this.access.locationIdsFor('orders.requests.create');
    if (scope !== 'all' && scope.length === 0) return [];
    const [locations, warehouses] = await Promise.all([
      this.db.location.findMany({
        where: { archivedAt: null, ...(scope === 'all' ? {} : { id: { in: scope } }) },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.db.warehouse.findMany({
        where: { archivedAt: null, isTransit: false },
        select: { id: true, name: true, locationId: true, isMain: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const main = warehouses.find((w) => w.isMain);
    return locations
      .filter((l) => !main || l.id !== main.locationId)
      .map((l) => {
        const own = warehouses.find((w) => w.locationId === l.id && !w.isMain);
        return {
          locationId: l.id,
          locationName: l.name,
          warehouseId: own?.id ?? null,
          warehouseName: own?.name ?? null,
        };
      });
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
          categoryId: true,
          category: { select: { name: true } },
          _count: { select: { variants: { where: { archivedAt: null } } } },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.db.stockLevel.findMany({
        where: { warehouseId },
        select: { itemId: true, quantity: true, expiresOn: true },
      }),
    ]);
    const quantity = new Map(levels.map((l) => [l.itemId, l.quantity.toFixed(3)]));
    // The earliest best-before of what is there (ADR 0062); none once it is gone.
    const expiry = new Map(
      levels.map((l) => [
        l.itemId,
        l.expiresOn && l.quantity.greaterThan(0) ? l.expiresOn.toISOString().slice(0, 10) : null,
      ]),
    );
    const names = new Map(items.map((i) => [i.id, i.name]));
    // Variants take their parent's category (ADR 0048).
    const byId = new Map(items.map((i) => [i.id, i]));
    const categoryOf = (i: (typeof items)[number]) =>
      i.parentItemId ? (byId.get(i.parentItemId) ?? i) : i;
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
        categoryId: categoryOf(i).categoryId,
        categoryName: categoryOf(i).category?.name ?? null,
        expiresOn: expiry.get(i.id) ?? null,
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
    // Branches send requests; owners and admins approve them, never send them.
    if (await this.access.can('orders.requests.approve')) throw ordersErrors.requestBranchOnly();
    const from = await this.source(body.fromWarehouseId);
    const target = await this.target(body);
    await this.access.assert('orders.requests.create', { locationId: target.locationId });
    return this.db.$transaction(async (tx) => {
      // A branch without a warehouse gets its store with its first request (ADR 0053).
      const to = target.warehouseId
        ? { id: target.warehouseId, locationId: target.locationId }
        : await this.branchStore(tx, tenantId, userId, target.locationId);
      if (from.id === to.id) throw ordersErrors.requestInvalid();
      const ids = body.lines.map((l) => l.itemId);
      const items = await tx.stockItem.findMany({
        where: { id: { in: ids }, archivedAt: null },
        select: { id: true, _count: { select: { variants: { where: { archivedAt: null } } } } },
      });
      const usable = new Set(items.filter((i) => i._count.variants === 0).map((i) => i.id));
      const missing = ids.filter((id) => !usable.has(id));
      if (missing.length > 0) throw ordersErrors.itemNotFound(missing);
      // No more than the source has now: a branch can't ask for 4 when 2 are there (below zero counts as none).
      const levels = await tx.stockLevel.findMany({
        where: { warehouseId: from.id, itemId: { in: ids } },
        select: { itemId: true, quantity: true },
      });
      const have = new Map(levels.map((l) => [l.itemId, new Decimal(l.quantity.toFixed(3))]));
      const above = body.lines
        .filter((l) => {
          const there = have.get(l.itemId) ?? new Decimal(0);
          return new Decimal(l.quantity).greaterThan(there.isNegative() ? new Decimal(0) : there);
        })
        .map((l) => l.itemId);
      if (above.length > 0) throw ordersErrors.requestAboveStock(above);
      const { number } = await this.numbering.next('orders.stockRequest', tx);
      // Without approval (orders.requestsNeedApproval off, ADR 0056) a request is approved as it is sent: every line
      // as asked, with its transfer number now; the warehouse finds it on its Picking list.
      const needsApproval = await this.settings.get('orders.requestsNeedApproval', {}, tx);
      const transferNumber = needsApproval
        ? null
        : (await this.numbering.next('orders.stockTransfer', tx)).number;
      const request = await tx.stockRequest.create({
        data: {
          tenantId,
          number,
          ...(transferNumber ? { status: 'approved' as const, transferNumber } : {}),
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
          ...(transferNumber ? { approvedQuantity: new Decimal(l.quantity).toFixed(3) } : {}),
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
      if (transferNumber) {
        // Approved by the organization's setting, not by a person: no user on the step.
        await tx.stockRequestEvent.create({
          data: { tenantId, requestId: request.id, status: 'approved', note: null, userId: null },
        });
      }
      const response = await this.read(tx, request.id);
      await this.audit.record(tx, {
        action: 'orders.stock_request.created',
        actor: auditActor.user(userId),
        entityId: request.id,
        after: requestSnapshot(response),
      });
      // Approvers hear about a request that waits for them; an approved one needs nobody's decision.
      if (!transferNumber) await this.notifyMove(tx, response, undefined);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** Where goods come from: the main warehouse when there is one (only it), else the one named. */
  private async source(fromWarehouseId: string | undefined) {
    const main = await this.db.warehouse.findFirst({
      where: { isMain: true, archivedAt: null },
      select: { id: true, locationId: true },
    });
    if (main) {
      if (fromWarehouseId !== undefined && fromWarehouseId !== main.id) {
        throw ordersErrors.mainOnly();
      }
      return main;
    }
    if (fromWarehouseId === undefined) throw ordersErrors.requestInvalid();
    const from = await this.db.warehouse.findUnique({
      where: { id: fromWarehouseId },
      select: { id: true, locationId: true, archivedAt: true, isTransit: true },
    });
    if (!from || from.archivedAt || from.isTransit) throw ordersErrors.warehouseNotFound();
    return { id: from.id, locationId: from.locationId };
  }

  /** Where goods go: the warehouse named, or the branch named (its own warehouse, else none yet). */
  private async target(
    body: CreateStockRequest,
  ): Promise<{ warehouseId: string | null; locationId: string }> {
    if (body.toWarehouseId !== undefined) {
      const to = await this.db.warehouse.findUnique({
        where: { id: body.toWarehouseId },
        select: { id: true, locationId: true, archivedAt: true, isTransit: true },
      });
      if (!to || to.archivedAt || to.isTransit) throw ordersErrors.warehouseNotFound();
      return { warehouseId: to.id, locationId: to.locationId };
    }
    const locationId = body.toLocationId;
    if (locationId === undefined) throw ordersErrors.requestInvalid();
    const location = await this.db.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) throw ordersErrors.warehouseNotFound();
    const own = await this.db.warehouse.findFirst({
      where: { locationId, archivedAt: null, isTransit: false, isMain: false },
      select: { id: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return { warehouseId: own?.id ?? null, locationId };
  }

  /**
   * The branch's store, created with its first request (ADR 0053): named like the branch, audited as a warehouse the
   * requester created. Inside the request's transaction, so a failed request leaves no store behind.
   */
  private async branchStore(
    tx: TenantTransactionClient,
    tenantId: string,
    userId: string,
    locationId: string,
  ): Promise<{ id: string; locationId: string }> {
    const existing = await tx.warehouse.findFirst({
      where: { locationId, archivedAt: null, isTransit: false, isMain: false },
      select: { id: true, locationId: true },
    });
    if (existing) return existing;
    const location = await tx.location.findUniqueOrThrow({
      where: { id: locationId },
      select: { name: true },
    });
    const row = await tx.warehouse.create({
      data: { tenantId, locationId, name: location.name.slice(0, 100), sortOrder: 0 },
      select: {
        id: true,
        locationId: true,
        name: true,
        sortOrder: true,
        suppliesStation: true,
        isMain: true,
        archivedAt: true,
      },
    });
    await this.audit.record(tx, {
      action: 'inventory.warehouse.created',
      actor: auditActor.user(userId),
      entityId: row.id,
      after: snapshot('warehouse', row),
    });
    return { id: row.id, locationId: row.locationId };
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
      (row) =>
        this.access.assertAtWarehouse('orders.requests.receive', {
          id: row.toWarehouseId,
          locationId: row.locationId,
        }),
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
      this.access.assertAtWarehouse('orders.picking.use', {
        id: row.fromWarehouseId,
        locationId: row.fromLocationId,
      }),
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
        await this.access.assertAtWarehouse('orders.picking.use', {
          id: row.fromWarehouseId,
          locationId: row.fromLocationId,
        });
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
      if (before.driverUserId !== driverUserId) {
        await this.notifyDriver(tx, after);
      }
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
      await this.notifyMove(tx, after, extra.driverUserId);
      await this.idempotency.completeInTransaction(tx, after);
      return after;
    });
  }

  /**
   * Who hears about a step (ADR 0047): a new request → approvers; approved / rejected → whoever asked; packed → the
   * branch's receivers ("on the way") and the driver if one was set; received with less than was sent → approvers.
   */
  private async notifyMove(
    tx: TenantTransactionClient,
    after: StockRequest,
    newDriverUserId: string | undefined,
  ): Promise<void> {
    const db = asTenantDb(tx);
    const params = requestParams(after);
    const send = (kind: NotificationKind, userIds: readonly string[]) =>
      this.notifications.notify(tx, {
        userIds,
        kind,
        entityType: 'stock_request',
        entityId: after.id,
        params,
      });
    const holderIds = async (key: PermissionKey, locationId?: string) =>
      (await this.members.holders(db, key, locationId)).map((h) => h.userId);
    switch (after.status) {
      case 'submitted':
        await send('request_submitted', await holderIds('orders.requests.approve'));
        return;
      case 'approved':
      case 'rejected': {
        const { requestedByUserId } = await tx.stockRequest.findUniqueOrThrow({
          where: { id: after.id },
          select: { requestedByUserId: true },
        });
        if (requestedByUserId) {
          const kind = after.status === 'approved' ? 'request_approved' : 'request_rejected';
          await send(kind, [requestedByUserId]);
        }
        return;
      }
      case 'packed':
        await send(
          'request_on_the_way',
          await holderIds('orders.requests.receive', after.locationId),
        );
        if (newDriverUserId) await this.notifyDriver(tx, after);
        return;
      case 'received':
        if (
          after.lines.some(
            (l) =>
              l.pickedQuantity !== null &&
              new Decimal(l.receivedQuantity ?? '0').lessThan(l.pickedQuantity),
          )
        ) {
          await send('request_short', await holderIds('orders.requests.approve'));
        }
        return;
      default:
        return;
    }
  }

  private async notifyDriver(tx: TenantTransactionClient, after: StockRequest): Promise<void> {
    if (!after.driverUserId) return;
    await this.notifications.notify(tx, {
      userIds: [after.driverUserId],
      kind: 'request_driver_assigned',
      entityType: 'stock_request',
      entityId: after.id,
      params: requestParams(after),
    });
  }

  private async read(tx: TenantTransactionClient, id: string): Promise<StockRequest> {
    const row: RequestRow = await tx.stockRequest.findUniqueOrThrow({
      where: { id },
      select: REQUEST_SELECT,
    });
    const names = await this.members.forUsers(asTenantDb(tx), namedUsers(row));
    return requestResponse(row, names);
  }
}

const isZero = (q: Qty) => new Decimal(q.toFixed(3)).isZero();

/** What the notification text needs: the transfer number once there is one, and the branch. */
const requestParams = (r: StockRequest): Record<string, string> => ({
  number: r.transferNumber ?? r.number,
  branch: r.locationName,
});

/** The people a response names: who asked, and the driver once there is one. */
const namedUsers = (row: { requestedByUserId: string; driverUserId: string | null }) =>
  row.driverUserId ? [row.requestedByUserId, row.driverUserId] : [row.requestedByUserId];

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
    requestedByName: names.get(row.requestedByUserId) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requestResponse(row: RequestRow, names: ReadonlyMap<string, string>): StockRequest {
  const q = (v: Qty | null) => v?.toFixed(3) ?? null;
  return {
    ...summaryResponse(row, names),
    note: row.note,
    // For the documents (ADR 0064).
    locationAddress: row.location.address,
    fromLocationAddress: row.fromWarehouse.location.address,
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
