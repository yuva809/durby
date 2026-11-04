import { Inject, Injectable } from '@nestjs/common';
import {
  type FloorQuery,
  type FloorTable,
  type KitchenTicket,
  type ListOrdersQuery,
  type Order,
  type OrderLine,
  type OrderSummary,
  PREP_STATIONS,
  type PrepStation,
  type SendTicketRequest,
  type SendTicketResponse,
  type TableOrderResponse,
  type UpdateOrderRequest,
  type VoidLinesRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { NumberingService } from '../../platform/numbering';
import { OutboxService } from '../../platform/outbox';
import { AccessService, MemberNames } from '../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { lineTotal, orderTotals } from './order-totals';
import { isUniqueViolation, posErrors } from './pos-errors';
import { LATEST_STATUS, statusOf } from './ticket-status';

type Db = TenantPrismaClient | TenantTransactionClient;

/** Tickets of one send or void go out kitchen first (ADR 0025). */
const STATION_ORDER: readonly PrepStation[] = PREP_STATIONS;

interface TicketLine {
  productId: string;
  productName: string;
  unitPrice: string;
  taxRate: string;
  quantity: number;
  note: string | null;
  voidsLineId: string | null;
}

/** Prisma returns `numeric` columns as Decimal objects; only their exact text is used here. */
type DecimalValue = { toFixed(digits: number): string };

const ORDER_SELECT = {
  id: true,
  number: true,
  tableId: true,
  locationId: true,
  status: true,
  covers: true,
  openedAt: true,
  closedAt: true,
  table: { select: { name: true } },
} as const;

const LINE_SELECT = {
  id: true,
  orderId: true,
  ticketId: true,
  productId: true,
  productName: true,
  unitPrice: true,
  taxRate: true,
  quantity: true,
  note: true,
  voidsLineId: true,
  createdAt: true,
} as const;

interface OrderRow {
  id: string;
  number: string;
  tableId: string;
  locationId: string;
  status: 'open' | 'closed';
  covers: number | null;
  openedAt: Date;
  closedAt: Date | null;
  table: { name: string };
}

interface LineRow {
  id: string;
  orderId: string;
  ticketId: string;
  productId: string;
  productName: string;
  unitPrice: DecimalValue;
  taxRate: DecimalValue;
  quantity: number;
  note: string | null;
  voidsLineId: string | null;
  createdAt: Date;
}

/**
 * Table orders and kitchen tickets (docs/modules/pos.md → Step 3). One open order per table;
 * tickets and lines are append-only, a correction is a void ticket (rule 7). All keys are
 * location-scoped and checked at the table's location: what the caller can't read doesn't exist
 * for them (404), what they can read but not change is 403.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly numbering: NumberingService,
    private readonly outbox: OutboxService,
    private readonly memberNames: MemberNames,
  ) {}

  async floor(query: FloorQuery): Promise<FloorTable[]> {
    const locations = await this.readableLocations(query.locationId);
    if (locations !== 'all' && locations.length === 0) return [];
    const tables = await this.db.diningTable.findMany({
      where: {
        archivedAt: null,
        ...(locations === 'all' ? {} : { locationId: { in: locations } }),
      },
      select: {
        id: true,
        locationId: true,
        name: true,
        seats: true,
        area: true,
        shape: true,
        color: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const open = await this.summaries(this.db, {
      status: 'open',
      tableId: { in: tables.map((t) => t.id) },
    });
    const byTable = new Map(open.map((o) => [o.tableId, o]));
    return tables.map((table) => ({ ...table, order: byTable.get(table.id) ?? null }));
  }

  async tableOrder(tableId: string): Promise<TableOrderResponse> {
    const table = await this.readableTable(tableId);
    const open = await this.db.posOrder.findFirst({
      where: { tableId, status: 'open' },
      select: { id: true },
    });
    return {
      table: {
        id: table.id,
        locationId: table.locationId,
        name: table.name,
        seats: table.seats,
        area: table.area,
        shape: table.shape,
        color: table.color,
      },
      order: open ? await this.load(this.db, open.id) : null,
    };
  }

  async list(query: ListOrdersQuery): Promise<OrderSummary[]> {
    const locations = await this.readableLocations(query.locationId);
    if (locations !== 'all' && locations.length === 0) return [];
    return this.summaries(
      this.db,
      {
        ...(query.status ? { status: query.status } : {}),
        ...(locations === 'all' ? {} : { locationId: { in: locations } }),
      },
      100,
    );
  }

  async get(id: string): Promise<Order> {
    await this.readableOrder(id);
    return this.load(this.db, id);
  }

  /** The full order in the caller's transaction (for writes of other pos services). */
  orderIn(tx: TenantTransactionClient, orderId: string): Promise<Order> {
    return this.load(tx, orderId);
  }

  /** Sends items to the kitchen: one ticket, opening the table's order if it has none. */
  async send(tableId: string, body: SendTicketRequest): Promise<SendTicketResponse> {
    const { tenantId, userId } = this.tenantContext.require();
    const table = await this.readableTable(tableId);
    if (table.archivedAt) throw posErrors.tableNotFound();
    await this.access.assert('pos.orders.take', { locationId: table.locationId });

    // Two first sends to a free table race on the one-open-order index; the loser retries once and
    // lands on the winner's order.
    return this.retryOnce(() =>
      this.db.$transaction(async (tx) => {
        const products = await this.availableProducts(
          tx,
          body.lines.map((l) => l.productId),
        );
        let orderId = await this.lockOpenOrder(tx, tableId);
        // `covers` counts only when this send opens the order. On an open order it is ignored: a
        // till may hold a value from before another waiter opened the table, and changes go
        // through PATCH /pos/orders/:id only.
        if (!orderId) {
          // As late as possible: the counter row stays locked until commit (ADR 0012).
          const { number } = await this.numbering.next('pos.order', tx);
          const order = await tx.posOrder.create({
            data: {
              tenantId,
              locationId: table.locationId,
              tableId,
              number,
              covers: body.covers ?? null,
              openedByUserId: userId,
            },
            select: ORDER_SELECT,
          });
          orderId = order.id;
          await this.audit.record(tx, {
            action: 'pos.order.opened',
            actor: auditActor.user(userId),
            entityId: order.id,
            after: orderSnapshot(order),
          });
          // A party sits at the table: consumers (reservations) react through the outbox.
          await this.outbox.add(tx, {
            type: 'pos.order.opened',
            payload: {
              orderId: order.id,
              locationId: table.locationId,
              tableId,
              openedAt: order.openedAt.toISOString(),
            },
          });
        }
        const ticketIds = await this.writeTickets(
          tx,
          orderId,
          'order',
          body.lines.map((line) => {
            const product = products.get(line.productId)!;
            return {
              station: product.category.station,
              line: {
                productId: product.id,
                productName: product.name,
                unitPrice: product.price.toFixed(2),
                taxRate: product.taxRate.toFixed(2),
                quantity: line.quantity,
                note: line.note || null,
                voidsLineId: null,
              },
            };
          }),
        );
        const response = await this.response(tx, orderId, ticketIds);
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  /** Voids sent items: a void ticket with negative lines pointing at them. */
  async voidLines(orderId: string, body: VoidLinesRequest): Promise<SendTicketResponse> {
    const order = await this.readableOrder(orderId);
    await this.access.assert('pos.orders.void', { locationId: order.locationId });
    return this.db.$transaction(async (tx) => {
      if ((await this.lockOrder(tx, orderId)) !== 'open') throw posErrors.orderClosed();
      const lines = await tx.posOrderLine.findMany({ where: { orderId }, select: LINE_SELECT });
      const left = remainingOf(lines);
      const sentLines = new Map(lines.filter((l) => l.quantity > 0).map((l) => [l.id, l]));
      const requested = new Map<string, number>();
      for (const { lineId, quantity } of body.lines) {
        if (!sentLines.has(lineId)) throw posErrors.lineNotFound();
        requested.set(lineId, (requested.get(lineId) ?? 0) + quantity);
      }
      for (const [lineId, quantity] of requested) {
        if (quantity > (left.get(lineId) ?? 0)) throw posErrors.voidExceeds(lineId);
      }
      // A void goes to the station that got the item, whatever its category says now.
      const stations = new Map(
        (
          await tx.posKitchenTicket.findMany({
            where: { orderId },
            select: { id: true, station: true },
          })
        ).map((t) => [t.id, t.station]),
      );
      const ticketIds = await this.writeTickets(
        tx,
        orderId,
        'void',
        [...requested].map(([lineId, quantity]) => {
          const line = sentLines.get(lineId)!;
          return {
            station: stations.get(line.ticketId)!,
            line: {
              productId: line.productId,
              productName: line.productName,
              unitPrice: line.unitPrice.toFixed(2),
              taxRate: line.taxRate.toFixed(2),
              quantity: -quantity,
              note: null,
              voidsLineId: lineId,
            },
          };
        }),
      );
      const response = await this.response(tx, orderId, ticketIds);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** Sets or clears the covers of an open order (`PATCH /pos/orders/:id`). */
  async update(orderId: string, body: UpdateOrderRequest): Promise<Order> {
    const { userId } = this.tenantContext.require();
    const order = await this.readableOrder(orderId);
    await this.access.assert('pos.orders.take', { locationId: order.locationId });
    return this.db.$transaction(async (tx) => {
      if ((await this.lockOrder(tx, orderId)) !== 'open') throw posErrors.orderClosed();
      await this.setCovers(tx, orderId, body.covers, userId);
      return this.load(tx, orderId);
    });
  }

  /** Closes the order and frees its table; closing a closed order changes nothing. */
  async close(orderId: string): Promise<Order> {
    const { userId } = this.tenantContext.require();
    const order = await this.readableOrder(orderId);
    await this.access.assert('pos.orders.close', { locationId: order.locationId });
    return this.db.$transaction(async (tx) => {
      if ((await this.lockOrder(tx, orderId)) === 'open') {
        const before = await tx.posOrder.findUniqueOrThrow({
          where: { id: orderId },
          select: ORDER_SELECT,
        });
        const after = await tx.posOrder.update({
          where: { id: orderId },
          data: { status: 'closed', closedAt: new Date(), closedByUserId: userId },
          select: ORDER_SELECT,
        });
        await this.audit.record(tx, {
          action: 'pos.order.closed',
          actor: auditActor.user(userId),
          entityId: orderId,
          before: orderSnapshot(before),
          after: orderSnapshot(after),
        });
        // The table is free: consumers (reservations) react through the outbox (ADR 0019 §7).
        await this.outbox.add(tx, {
          type: 'pos.order.closed',
          payload: { orderId, locationId: after.locationId, tableId: after.tableId },
        });
      }
      return this.load(tx, orderId);
    });
  }

  /** The table, if it exists here and the caller may read orders at its location. */
  private async readableTable(tableId: string) {
    const table = await this.db.diningTable.findUnique({
      where: { id: tableId },
      select: {
        id: true,
        locationId: true,
        name: true,
        seats: true,
        area: true,
        shape: true,
        color: true,
        archivedAt: true,
      },
    });
    if (!table || !(await this.access.can('pos.orders.read', { locationId: table.locationId }))) {
      throw posErrors.tableNotFound();
    }
    return table;
  }

  private async readableOrder(orderId: string) {
    const order = await this.db.posOrder.findUnique({
      where: { id: orderId },
      select: { id: true, locationId: true },
    });
    if (!order || !(await this.access.can('pos.orders.read', { locationId: order.locationId }))) {
      throw posErrors.orderNotFound();
    }
    return order;
  }

  /** `'all'`, or the locations to show: the requested one if readable, else every readable one. */
  private async readableLocations(locationId: string | undefined): Promise<'all' | string[]> {
    const scope = await this.access.locationIdsFor('pos.orders.read');
    if (!locationId) return scope;
    return scope === 'all' || scope.includes(locationId) ? [locationId] : [];
  }

  /** Products that can be ordered (not archived, category not archived), or 409 naming the rest. */
  private async availableProducts(tx: TenantTransactionClient, ids: string[]) {
    const wanted = [...new Set(ids)];
    const rows = await tx.product.findMany({
      where: { id: { in: wanted }, archivedAt: null, category: { archivedAt: null } },
      select: {
        id: true,
        name: true,
        price: true,
        taxRate: true,
        category: { select: { station: true } },
      },
    });
    const found = new Map(rows.map((p) => [p.id, p]));
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length > 0) throw posErrors.productUnavailable(missing);
    return found;
  }

  /** The table's open order, locked for this transaction, or null. */
  private async lockOpenOrder(
    tx: TenantTransactionClient,
    tableId: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM pos_orders WHERE table_id = ${tableId}::uuid AND status = 'open' FOR UPDATE`;
    return rows[0]?.id ?? null;
  }

  /** Locks the order row (serializes tickets of one order) and returns its status. */
  private async lockOrder(
    tx: TenantTransactionClient,
    orderId: string,
  ): Promise<string | undefined> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM pos_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    return rows[0]?.status;
  }

  /** Changes the covers of a locked, open order, audited; the same value changes nothing. */
  private async setCovers(
    tx: TenantTransactionClient,
    orderId: string,
    covers: number | null,
    userId: string,
  ): Promise<void> {
    const before = await tx.posOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: ORDER_SELECT,
    });
    if (before.covers === covers) return;
    const after = await tx.posOrder.update({
      where: { id: orderId },
      data: { covers },
      select: ORDER_SELECT,
    });
    await this.audit.record(tx, {
      action: 'pos.order.updated',
      actor: auditActor.user(userId),
      entityId: orderId,
      before: orderSnapshot(before),
      after: orderSnapshot(after),
    });
  }

  /** A send or void response: the order and its new tickets in sequence order (ADR 0025). */
  private async response(
    tx: TenantTransactionClient,
    orderId: string,
    ticketIds: string[],
  ): Promise<SendTicketResponse> {
    return { order: await this.load(tx, orderId), ticketId: ticketIds[0]!, ticketIds };
  }

  /**
   * One ticket per station the lines go to, kitchen first, in the lines' order within each
   * (ADR 0025). Returns the ticket ids in sequence order.
   */
  private async writeTickets(
    tx: TenantTransactionClient,
    orderId: string,
    kind: 'order' | 'void',
    lines: { station: PrepStation; line: TicketLine }[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const station of STATION_ORDER) {
      const group = lines.filter((l) => l.station === station).map((l) => l.line);
      if (group.length > 0) ids.push(await this.writeTicket(tx, orderId, kind, station, group));
    }
    return ids;
  }

  /** The next ticket of a locked order with its lines, audited. Returns the ticket id. */
  private async writeTicket(
    tx: TenantTransactionClient,
    orderId: string,
    kind: 'order' | 'void',
    station: PrepStation,
    lines: TicketLine[],
  ): Promise<string> {
    const { tenantId, userId } = this.tenantContext.require();
    const last = await tx.posKitchenTicket.aggregate({
      where: { orderId },
      _max: { sequence: true },
    });
    const ticket = await tx.posKitchenTicket.create({
      data: {
        tenantId,
        orderId,
        sequence: (last._max.sequence ?? 0) + 1,
        kind,
        station,
        createdByUserId: userId,
      },
      select: { id: true, orderId: true, sequence: true, kind: true, station: true },
    });
    await tx.posOrderLine.createMany({
      data: lines.map((line) => ({
        ...line,
        tenantId,
        orderId,
        ticketId: ticket.id,
        createdByUserId: userId,
      })),
    });
    await this.audit.record(tx, {
      action: 'pos.kitchen_ticket.created',
      actor: auditActor.user(userId),
      entityId: ticket.id,
      after: snapshot('kitchen_ticket', { ...ticket, lineCount: lines.length }),
    });
    return ticket.id;
  }

  /** The full order: tickets in order, their lines with what is left, and totals. */
  private async load(db: Db, orderId: string): Promise<Order> {
    const { openedByUserId, ...order } = await db.posOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { ...ORDER_SELECT, openedByUserId: true },
    });
    const [tickets, lines, names] = await Promise.all([
      db.posKitchenTicket.findMany({
        where: { orderId },
        select: {
          id: true,
          sequence: true,
          kind: true,
          station: true,
          createdAt: true,
          statusChanges: LATEST_STATUS,
        },
        orderBy: { sequence: 'asc' },
      }),
      db.posOrderLine.findMany({ where: { orderId }, select: LINE_SELECT, orderBy: { id: 'asc' } }),
      this.memberNames.forUsers(db, [openedByUserId]),
    ]);
    const left = remainingOf(lines);
    const totals = orderTotals(lines.map(priced));
    const byTicket = new Map<string, OrderLine[]>();
    for (const line of lines) {
      const list = byTicket.get(line.ticketId) ?? [];
      list.push(lineResponse(line, left.get(line.id) ?? 0));
      byTicket.set(line.ticketId, list);
    }
    const ticketList: KitchenTicket[] = tickets.map((t) => ({
      id: t.id,
      sequence: t.sequence,
      kind: t.kind,
      station: t.station,
      status: statusOf(t.statusChanges),
      createdAt: t.createdAt.toISOString(),
      lines: byTicket.get(t.id) ?? [],
    }));
    return {
      ...summaryOf(order, totals.itemCount, totals.gross, readyCount(ticketList)),
      tickets: ticketList,
      totals,
      waiterName: names.get(openedByUserId) ?? null,
    };
  }

  /** Order summaries (newest first) with item count and gross total. */
  private async summaries(
    db: Db,
    where: Record<string, unknown>,
    take?: number,
  ): Promise<OrderSummary[]> {
    const orders: OrderRow[] = await db.posOrder.findMany({
      where,
      select: ORDER_SELECT,
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      ...(take ? { take } : {}),
    });
    if (orders.length === 0) return [];
    const ids = orders.map((o) => o.id);
    const [lines, tickets] = await Promise.all([
      db.posOrderLine.findMany({
        where: { orderId: { in: ids } },
        select: { orderId: true, unitPrice: true, taxRate: true, quantity: true },
      }),
      db.posKitchenTicket.findMany({
        where: { orderId: { in: ids } },
        select: { orderId: true, statusChanges: LATEST_STATUS },
      }),
    ]);
    const ready = new Map<string, number>();
    for (const t of tickets) {
      if (statusOf(t.statusChanges) === 'ready')
        ready.set(t.orderId, (ready.get(t.orderId) ?? 0) + 1);
    }
    const byOrder = new Map<string, ReturnType<typeof priced>[]>();
    for (const line of lines) {
      byOrder.set(line.orderId, [...(byOrder.get(line.orderId) ?? []), priced(line)]);
    }
    return orders.map((order) => {
      const totals = orderTotals(byOrder.get(order.id) ?? []);
      return summaryOf(order, totals.itemCount, totals.gross, ready.get(order.id) ?? 0);
    });
  }

  private async retryOnce<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return fn();
    }
  }
}

/** What is left of each sent line after its voids (void lines carry negative quantities). */
function remainingOf(lines: readonly Pick<LineRow, 'id' | 'quantity' | 'voidsLineId'>[]) {
  const left = new Map<string, number>();
  for (const line of lines) if (line.quantity > 0) left.set(line.id, line.quantity);
  for (const line of lines) {
    if (line.voidsLineId)
      left.set(line.voidsLineId, (left.get(line.voidsLineId) ?? 0) + line.quantity);
  }
  return left;
}

function priced(line: Pick<LineRow, 'unitPrice' | 'taxRate' | 'quantity'>) {
  return {
    unitPrice: line.unitPrice.toFixed(2),
    taxRate: line.taxRate.toFixed(2),
    quantity: line.quantity,
  };
}

function lineResponse(line: LineRow, remaining: number): OrderLine {
  const unitPrice = line.unitPrice.toFixed(2);
  return {
    id: line.id,
    ticketId: line.ticketId,
    productId: line.productId,
    productName: line.productName,
    unitPrice,
    taxRate: line.taxRate.toFixed(2),
    quantity: line.quantity,
    note: line.note,
    voidsLineId: line.voidsLineId,
    remaining: line.quantity > 0 ? remaining : 0,
    total: lineTotal(unitPrice, line.quantity),
    createdAt: line.createdAt.toISOString(),
  };
}

/** Tickets ready to serve (ADR 0026). */
function readyCount(tickets: readonly KitchenTicket[]): number {
  return tickets.filter((t) => t.status === 'ready').length;
}

function summaryOf(order: OrderRow, itemCount: number, gross: string, ready: number): OrderSummary {
  return {
    id: order.id,
    number: order.number,
    tableId: order.tableId,
    tableName: order.table.name,
    locationId: order.locationId,
    status: order.status,
    openedAt: order.openedAt.toISOString(),
    closedAt: order.closedAt?.toISOString() ?? null,
    covers: order.covers,
    itemCount,
    gross,
    readyCount: ready,
  };
}

function orderSnapshot(order: OrderRow) {
  return snapshot('pos_order', {
    id: order.id,
    number: order.number,
    tableId: order.tableId,
    locationId: order.locationId,
    status: order.status,
    covers: order.covers,
    closedAt: order.closedAt,
  });
}
