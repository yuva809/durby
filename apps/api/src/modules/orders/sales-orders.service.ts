import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type {
  CancelSalesOrderRequest,
  CreateSalesOrderRequest,
  DispatchSalesOrderRequest,
  ListSalesOrdersQuery,
  NotificationKind,
  PermissionKey,
  PickSalesOrderRequest,
  SalesOrder,
  SalesOrderLineRequest,
  SalesOrderListResponse,
  SalesOrderNoteRequest,
  SalesOrderStatus,
  SalesOrderSummary,
  StockUnit,
  UpdateSalesOrderRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { NotificationService } from '../../platform/notifications';
import { NumberingService } from '../../platform/numbering';
import { AccessService, MemberNames } from '../../platform/rbac';
import { StockService } from '../inventory';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { canMove, decodeCursor, encodeCursor, lineTotal, orderTotal } from './order-math';
import { ordersErrors } from './orders-errors';

type Money = { toFixed(digits: number): string };

const SALES_NOTIFY: Partial<
  Record<SalesOrderStatus, { kind: NotificationKind; key: PermissionKey }>
> = {
  confirmed: { kind: 'sales_confirmed', key: 'orders.picking.use' },
  packed: { kind: 'sales_packed', key: 'orders.delivery.use' },
  returned: { kind: 'sales_returned', key: 'orders.orders.edit' },
};

const SUMMARY_SELECT = {
  id: true,
  number: true,
  status: true,
  customerId: true,
  locationId: true,
  warehouseId: true,
  requestedDate: true,
  total: true,
  deliveryAddress: true,
  driverName: true,
  dispatchedAt: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { name: true } },
  location: { select: { name: true } },
  warehouse: { select: { name: true } },
  _count: { select: { lines: true } },
} as const;

const ORDER_SELECT = {
  ...SUMMARY_SELECT,
  note: true,
  driverPhone: true,
  vehicle: true,
  lines: {
    select: {
      id: true,
      itemId: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      pickedQuantity: true,
      item: { select: { name: true, unit: true } },
    },
    // Lines are written in one createMany in form order: sortOrder is unique per order.
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
  status: SalesOrderStatus;
  customerId: string;
  locationId: string;
  warehouseId: string;
  requestedDate: Date | null;
  total: Money;
  deliveryAddress: string | null;
  driverName: string | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  customer: { name: string };
  location: { name: string };
  warehouse: { name: string };
  _count: { lines: number };
}

interface OrderRow extends SummaryRow {
  note: string | null;
  driverPhone: string | null;
  vehicle: string | null;
  lines: {
    id: string;
    itemId: string;
    quantity: Money;
    unitPrice: Money;
    lineTotal: Money;
    pickedQuantity: Money | null;
    item: { name: string; unit: StockUnit };
  }[];
  events: {
    id: string;
    status: SalesOrderStatus;
    note: string | null;
    userId: string | null;
    createdAt: Date;
  }[];
}

/**
 * Sales orders (docs/modules/orders.md, ADR 0044): stock items for a customer, leaving from one warehouse; the order's
 * branch is the warehouse's location and every key is checked there. Drafts can be edited (lines replaced as a
 * whole); confirm and cancel move the status; picking books the goods out of the warehouse (step 3), a cancel after
 * picking or a return books them back. Each change writes a timeline row and an audit row in its transaction.
 */
@Injectable()
export class SalesOrdersService {
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
  ) {}

  async list(query: ListSalesOrdersQuery): Promise<SalesOrderListResponse> {
    const meta = { nextCursor: null, limit: query.limit };
    const scope = await this.access.locationIdsFor('orders.orders.read');
    if (scope !== 'all' && scope.length === 0) return { data: [], meta };
    const cursorId = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursorId) return { data: [], meta };
    const rows: SummaryRow[] = await this.db.salesOrder.findMany({
      where: {
        AND: [
          scope === 'all' ? {} : { locationId: { in: scope } },
          query.locationId ? { locationId: query.locationId } : {},
          query.customerId ? { customerId: query.customerId } : {},
          query.status ? { status: { in: query.status } } : {},
          query.from || query.to
            ? {
                createdAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lt: new Date(query.to) } : {}),
                },
              }
            : {},
          cursorId ? { id: { lt: cursorId } } : {},
        ],
      },
      select: SUMMARY_SELECT,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(summaryResponse),
      meta: {
        nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!.id) : null,
        limit: query.limit,
      },
    };
  }

  async get(id: string): Promise<SalesOrder> {
    const row: OrderRow | null = await this.db.salesOrder.findUnique({
      where: { id },
      select: ORDER_SELECT,
    });
    if (!row || !(await this.access.can('orders.orders.read', { locationId: row.locationId }))) {
      throw ordersErrors.orderNotFound();
    }
    return orderResponse(row);
  }

  async create(body: CreateSalesOrderRequest): Promise<SalesOrder> {
    const { tenantId, userId } = this.tenantContext.require();
    const warehouse = await this.usableWarehouse(body.warehouseId, 'orders.orders.create');
    return this.db.$transaction(async (tx) => {
      await activeCustomer(tx, body.customerId);
      const lines = await pricedLines(tx, body.lines);
      const status: SalesOrderStatus = body.confirm ? 'confirmed' : 'draft';
      // As late as possible: the counter row stays locked until commit (ADR 0012).
      const { number } = await this.numbering.next('orders.salesOrder', tx);
      const order = await tx.salesOrder.create({
        data: {
          tenantId,
          number,
          status,
          customerId: body.customerId,
          locationId: warehouse.locationId,
          warehouseId: warehouse.id,
          requestedDate: dayOf(body.requestedDate),
          deliveryAddress: body.deliveryAddress ?? null,
          note: body.note ?? null,
          total: orderTotal(lines.map((l) => l.lineTotal)),
          createdByUserId: userId,
        },
        select: { id: true },
      });
      await writeLines(tx, tenantId, order.id, lines);
      await tx.salesOrderEvent.createMany({
        data: [
          { tenantId, orderId: order.id, status: 'draft', userId },
          ...(status === 'confirmed'
            ? [{ tenantId, orderId: order.id, status: 'confirmed' as const, userId }]
            : []),
        ],
      });
      const response = await readOrder(tx, order.id);
      await this.audit.record(tx, {
        action: 'orders.sales_order.created',
        actor: auditActor.user(userId),
        entityId: order.id,
        after: orderSnapshot(response),
      });
      await this.notifyStatus(tx, response);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  async update(id: string, body: UpdateSalesOrderRequest): Promise<SalesOrder> {
    const { tenantId, userId } = this.tenantContext.require();
    const current = await this.editable(id);
    const warehouse =
      body.warehouseId && body.warehouseId !== current.warehouseId
        ? await this.usableWarehouse(body.warehouseId, 'orders.orders.edit')
        : null;
    return this.db.$transaction(async (tx) => {
      const before = await readOrder(tx, id);
      // Re-read inside the transaction: someone may have confirmed it meanwhile.
      if (before.status !== 'draft') throw ordersErrors.notEditable();
      if (body.customerId) await activeCustomer(tx, body.customerId);
      const lines = body.lines ? await pricedLines(tx, body.lines) : null;
      await tx.salesOrder.update({
        where: { id },
        data: {
          ...(body.customerId ? { customerId: body.customerId } : {}),
          ...(warehouse ? { warehouseId: warehouse.id, locationId: warehouse.locationId } : {}),
          ...(body.requestedDate !== undefined ? { requestedDate: dayOf(body.requestedDate) } : {}),
          ...(body.deliveryAddress !== undefined ? { deliveryAddress: body.deliveryAddress } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(lines ? { total: orderTotal(lines.map((l) => l.lineTotal)) } : {}),
        },
      });
      if (lines) {
        await tx.salesOrderLine.deleteMany({ where: { orderId: id } });
        await writeLines(tx, tenantId, id, lines);
      }
      const after = await readOrder(tx, id);
      await this.audit.record(tx, {
        action: 'orders.sales_order.updated',
        actor: auditActor.user(userId),
        entityId: id,
        before: orderSnapshot(before),
        after: orderSnapshot(after),
      });
      return after;
    });
  }

  confirm(id: string): Promise<SalesOrder> {
    return this.move(id, 'confirmed', { key: 'orders.orders.edit', note: null });
  }

  /** Up to packed; after picking the goods go back into the warehouse. */
  cancel(id: string, body: CancelSalesOrderRequest): Promise<SalesOrder> {
    return this.move(id, 'cancelled', {
      key: 'orders.orders.delete',
      note: body.reason || null,
      apply: async (tx, before) => {
        if (before.status === 'packed') await this.restock(tx, before);
        return {};
      },
    });
  }

  /** Someone is at the shelves: the order shows as picking. */
  startPicking(id: string): Promise<SalesOrder> {
    return this.move(id, 'picking', { key: 'orders.picking.use', note: null });
  }

  /**
   * The picked quantity of every line (at most what was ordered; 0 = none on the shelf): one goods issue for what was
   * picked, and the order is packed. Refused below zero stock unless the branch allows negative stock.
   */
  pick(id: string, body: PickSalesOrderRequest): Promise<SalesOrder> {
    const { userId } = this.tenantContext.require();
    return this.move(id, 'packed', {
      key: 'orders.picking.use',
      note: null,
      apply: async (tx, before) => {
        const picked = new Map(body.lines.map((l) => [l.lineId, l.quantity]));
        const valid =
          picked.size === body.lines.length &&
          picked.size === before.lines.length &&
          before.lines.every((line) => {
            const quantity = picked.get(line.id);
            return quantity !== undefined && new Decimal(quantity).lte(line.quantity);
          });
        if (!valid) throw ordersErrors.pickInvalid();
        for (const line of before.lines) {
          await tx.salesOrderLine.update({
            where: { id: line.id },
            data: { pickedQuantity: new Decimal(picked.get(line.id)!).toFixed(3) },
          });
        }
        await this.stock.bookForOrder(tx, {
          kind: 'issue',
          warehouseId: before.warehouseId,
          orderId: before.id,
          lines: before.lines.map((l) => ({ itemId: l.itemId, quantity: picked.get(l.id)! })),
          userId,
        });
        return {};
      },
    });
  }

  /** On the way: who drives it (personal data: kept on the order, never in the audit log). */
  dispatch(id: string, body: DispatchSalesOrderRequest): Promise<SalesOrder> {
    return this.move(id, 'dispatched', {
      key: 'orders.delivery.use',
      note: body.note ?? null,
      apply: () =>
        Promise.resolve({
          driverName: body.driverName ?? null,
          driverPhone: body.driverPhone ?? null,
          vehicle: body.vehicle ?? null,
          dispatchedAt: new Date(),
        }),
    });
  }

  deliver(id: string, body: SalesOrderNoteRequest): Promise<SalesOrder> {
    return this.move(id, 'delivered', {
      key: 'orders.delivery.use',
      note: body.note || null,
      apply: () => Promise.resolve({ deliveredAt: new Date() }),
    });
  }

  /** Not delivered: the goods come back into the warehouse they left. */
  returnOrder(id: string, body: SalesOrderNoteRequest): Promise<SalesOrder> {
    return this.move(id, 'returned', {
      key: 'orders.delivery.use',
      note: body.note || null,
      apply: async (tx, before) => {
        await this.restock(tx, before);
        return {};
      },
    });
  }

  private async restock(tx: TenantTransactionClient, order: SalesOrder): Promise<void> {
    const { userId } = this.tenantContext.require();
    await this.stock.bookForOrder(tx, {
      kind: 'restock',
      warehouseId: order.warehouseId,
      orderId: order.id,
      lines: order.lines.map((l) => ({ itemId: l.itemId, quantity: l.pickedQuantity ?? '0' })),
      userId,
    });
  }

  /**
   * A status change: checked against canMove inside the transaction (the row is locked first); `apply` does the
   * step's own work in the same transaction (stock, picked quantities) and returns columns to set with the status.
   */
  private async move(
    id: string,
    to: SalesOrderStatus,
    step: {
      key: PermissionKey;
      note: string | null;
      apply?: (tx: TenantTransactionClient, before: SalesOrder) => Promise<StatusColumns>;
    },
  ): Promise<SalesOrder> {
    const { tenantId, userId } = this.tenantContext.require();
    const note = step.note;
    await this.visible(id, step.key);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await readOrder(tx, id);
      if (!canMove(before.status, to)) throw ordersErrors.invalidTransition(before.status, to);
      const extra = (await step.apply?.(tx, before)) ?? {};
      await tx.salesOrder.update({ where: { id }, data: { status: to, ...extra } });
      await tx.salesOrderEvent.create({
        data: { tenantId, orderId: id, status: to, note, userId },
      });
      const after = await readOrder(tx, id);
      await this.audit.record(tx, {
        action: 'orders.sales_order.status_changed',
        actor: auditActor.user(userId),
        entityId: id,
        before: orderSnapshot(before),
        after: orderSnapshot(after),
      });
      await this.notifyStatus(tx, after);
      // Appends a timeline row: the key completes with it (rule 8).
      await this.idempotency.completeInTransaction(tx, after);
      return after;
    });
  }

  /**
   * Who hears about a step (ADR 0047), at the order's branch: confirmed → whoever picks; packed → whoever delivers;
   * returned → whoever edits orders. Only the number goes in the text (the customer may be a person).
   */
  private async notifyStatus(tx: TenantTransactionClient, order: SalesOrder): Promise<void> {
    const step = SALES_NOTIFY[order.status];
    if (!step) return;
    const holders = await this.members.holders(asTenantDb(tx), step.key, order.locationId);
    await this.notifications.notify(tx, {
      userIds: holders.map((h) => h.userId),
      kind: step.kind,
      entityType: 'sales_order',
      entityId: order.id,
      params: { number: order.number },
    });
  }

  /** The order, if the caller can read it at its branch (else 404) and holds `key` there (else 403). */
  private async visible(id: string, key: PermissionKey) {
    const order = await this.db.salesOrder.findUnique({
      where: { id },
      select: { id: true, status: true, locationId: true, warehouseId: true },
    });
    if (
      !order ||
      !(await this.access.can('orders.orders.read', { locationId: order.locationId }))
    ) {
      throw ordersErrors.orderNotFound();
    }
    await this.access.assert(key, { locationId: order.locationId });
    return order;
  }

  private async editable(id: string) {
    const order = await this.visible(id, 'orders.orders.edit');
    if (order.status !== 'draft') throw ordersErrors.notEditable();
    return order;
  }

  /** An active warehouse the caller can read orders at; `key` is asserted at its location. */
  private async usableWarehouse(id: string, key: PermissionKey) {
    const warehouse = await this.db.warehouse.findUnique({
      where: { id },
      select: { id: true, locationId: true, archivedAt: true },
    });
    if (
      !warehouse ||
      warehouse.archivedAt ||
      !(await this.access.canAtWarehouse('orders.orders.read', warehouse))
    ) {
      throw ordersErrors.warehouseNotFound();
    }
    // At the warehouse, and one of the caller's when they are limited to some (ADR 0057).
    await this.access.assertAtWarehouse(key, warehouse);
    return warehouse;
  }
}

/** Columns a status step sets with the status (delivery details and times). */
interface StatusColumns {
  driverName?: string | null;
  driverPhone?: string | null;
  vehicle?: string | null;
  dispatchedAt?: Date;
  deliveredAt?: Date;
}

interface PricedLine extends SalesOrderLineRequest {
  lineTotal: string;
}

async function activeCustomer(tx: TenantTransactionClient, id: string): Promise<void> {
  const customer = await tx.orderCustomer.findUnique({
    where: { id },
    select: { archivedAt: true },
  });
  if (!customer || customer.archivedAt) throw ordersErrors.customerNotFound();
}

/** Items an order may sell: known, active, without active variants (a parent holds no stock, ADR 0038). */
async function pricedLines(
  tx: TenantTransactionClient,
  lines: readonly SalesOrderLineRequest[],
): Promise<PricedLine[]> {
  const ids = lines.map((l) => l.itemId);
  const items = await tx.stockItem.findMany({
    where: { id: { in: ids }, archivedAt: null },
    select: { id: true, _count: { select: { variants: { where: { archivedAt: null } } } } },
  });
  const usable = new Set(items.filter((i) => i._count.variants === 0).map((i) => i.id));
  const missing = ids.filter((id) => !usable.has(id));
  if (missing.length > 0) throw ordersErrors.itemNotFound(missing);
  return lines.map((l) => ({ ...l, lineTotal: lineTotal(l.quantity, l.unitPrice) }));
}

async function writeLines(
  tx: TenantTransactionClient,
  tenantId: string,
  orderId: string,
  lines: readonly PricedLine[],
): Promise<void> {
  await tx.salesOrderLine.createMany({
    data: lines.map((l, index) => ({
      tenantId,
      orderId,
      itemId: l.itemId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      sortOrder: index,
    })),
  });
}

async function readOrder(tx: TenantTransactionClient, id: string): Promise<SalesOrder> {
  const row: OrderRow | null = await tx.salesOrder.findUnique({
    where: { id },
    select: ORDER_SELECT,
  });
  if (!row) throw ordersErrors.orderNotFound();
  return orderResponse(row);
}

/** `YYYY-MM-DD` as the date column stores it (midnight UTC); null clears it. */
const dayOf = (day: string | null | undefined): Date | null =>
  day ? new Date(`${day}T00:00:00.000Z`) : null;

const orderSnapshot = (order: SalesOrder) => snapshot('sales_order', order);

function summaryResponse(row: SummaryRow): SalesOrderSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    customerId: row.customerId,
    customerName: row.customer.name,
    locationId: row.locationId,
    locationName: row.location.name,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse.name,
    requestedDate: row.requestedDate?.toISOString().slice(0, 10) ?? null,
    lineCount: row._count.lines,
    total: row.total.toFixed(2),
    deliveryAddress: row.deliveryAddress,
    driverName: row.driverName,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function orderResponse(row: OrderRow): SalesOrder {
  return {
    ...summaryResponse(row),
    note: row.note,
    driverPhone: row.driverPhone,
    vehicle: row.vehicle,
    lines: row.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      itemName: l.item.name,
      unit: l.item.unit,
      quantity: l.quantity.toFixed(3),
      unitPrice: l.unitPrice.toFixed(2),
      lineTotal: l.lineTotal.toFixed(2),
      pickedQuantity: l.pickedQuantity?.toFixed(3) ?? null,
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
