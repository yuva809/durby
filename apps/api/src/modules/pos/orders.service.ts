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
  type StationProcessing,
  type TableOrderResponse,
  type MergeOrderRequest,
  type TransferOrderRequest,
  type TransferOrderResponse,
  type MoveOrderRequest,
  type UpdateOrderRequest,
  type VoidLinesRequest,
} from '@durby/shared';
import { v7 as uuidv7 } from 'uuid';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { Clock } from '../../platform/auth';
import { SettingsService } from '../../platform/config/settings';
import { IdempotencyService } from '../../platform/idempotency';
import { NumberingService } from '../../platform/numbering';
import { OutboxService } from '../../platform/outbox';
import { AccessService, MemberNames } from '../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantDb,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { PricingService } from '../catalog';
import Decimal from 'decimal.js';
import { billedByLine, remainingOf, unbilledGross, unbilledOf } from './billing';
import { activeDiscounts } from './discounts.service';
import { lineTotal, orderTotals } from './order-totals';
import { isUniqueViolation, posErrors } from './pos-errors';
import { PrintJobsService } from './print-jobs.service';
import { currentOrderByTicket, ticketIdsOf } from './ticket-placements';
import { LATEST_STATUS, statusOf } from './ticket-status';

type Db = TenantDb;

/** Tickets of one send or void go out kitchen first (ADR 0025). */
const STATION_ORDER: readonly PrepStation[] = PREP_STATIONS;

/** Where a ticket comes from (ADR 0081): the send that wrote it, or a transfer. Neither for a void. */
interface TicketOrigin {
  sendId?: string;
  transferred?: boolean;
}

interface TicketLine {
  productId: string;
  productName: string;
  unitPrice: string;
  taxRate: string;
  quantity: number;
  note: string | null;
  voidsLineId: string | null;
  seat: number | null;
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
  seat: true,
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
  seat: number | null;
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
    private readonly pricing: PricingService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly printJobs: PrintJobsService,
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
    const open = await this.summaries(asTenantDb(this.db), {
      status: 'open',
      tableId: { in: tables.map((t) => t.id) },
    });
    const byTable = new Map(open.map((o) => [o.tableId, o]));
    const lastOrder = await this.lastTicketAt(
      asTenantDb(this.db),
      open.map((o) => o.id),
    );
    return tables.map((table) => {
      const order = byTable.get(table.id) ?? null;
      return {
        ...table,
        order,
        seatedAt: order?.openedAt ?? null,
        lastOrderAt: order ? (lastOrder.get(order.id) ?? null) : null,
      };
    });
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
      order: open ? await this.load(asTenantDb(this.db), open.id) : null,
      processing: await this.processing(table.locationId),
    };
  }

  /**
   * Whether each station prepares what is sent at the location (ADR 0031): `pos.kitchenProcessing`
   * and `pos.barProcessing` there. Off: its items go straight to the bill (a direct ticket).
   */
  private async processing(
    locationId: string,
    tx?: TenantTransactionClient,
  ): Promise<StationProcessing> {
    const resolved = await this.settings.all({ locationId }, tx);
    return {
      kitchen: resolved.get('pos.kitchenProcessing')?.value !== false,
      bar: resolved.get('pos.barProcessing')?.value !== false,
    };
  }

  async list(query: ListOrdersQuery): Promise<OrderSummary[]> {
    const locations = await this.readableLocations(query.locationId);
    if (locations !== 'all' && locations.length === 0) return [];
    return this.summaries(
      asTenantDb(this.db),
      {
        ...(query.status ? { status: query.status } : {}),
        ...(locations === 'all' ? {} : { locationId: { in: locations } }),
      },
      100,
    );
  }

  async get(id: string): Promise<Order> {
    await this.readableOrder(id);
    return this.load(asTenantDb(this.db), id);
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
          table.locationId,
        );
        const processing = await this.processing(table.locationId, tx);
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
          // Its kitchen and bar tickets are one round (ADR 0081).
          { sendId: uuidv7() },
          body.lines.map((line) => {
            const product = products.get(line.productId)!;
            return {
              station: product.station,
              direct: !processing[product.station],
              line: {
                productId: product.id,
                productName: product.name,
                // The location's price now, after price rules (ADR 0030).
                unitPrice: product.price,
                taxRate: product.taxRate,
                quantity: line.quantity,
                note: line.note || null,
                voidsLineId: null,
                seat: line.seat ?? null,
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
      const portions = await this.takeOff(tx, orderId, body.lines);
      const ticketIds = await this.writeTickets(
        tx,
        orderId,
        'void',
        {},
        portions.map(({ line, quantity, station, direct }) => ({
          station,
          direct,
          line: {
            productId: line.productId,
            productName: line.productName,
            unitPrice: line.unitPrice.toFixed(2),
            taxRate: line.taxRate.toFixed(2),
            quantity: -quantity,
            note: null,
            voidsLineId: line.id,
            seat: line.seat,
          },
        })),
      );
      const response = await this.response(tx, orderId, ticketIds);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /**
   * Moves sent items to a new order at a free table (ADR 0069, step 6). The source gets a void for them; the new order
   * gets a sale of the same products at the same prices, so its ticket shows what it sells. Both are normal tickets.
   * Only unbilled items without a discount move. The destination table must be free and at the same location.
   */
  async transfer(sourceId: string, body: TransferOrderRequest): Promise<TransferOrderResponse> {
    const { tenantId, userId } = this.tenantContext.require();
    const source = await this.readableOrder(sourceId);
    await this.access.assert('pos.orders.take', { locationId: source.locationId });
    return this.db.$transaction(async (tx) => {
      if ((await this.lockOrder(tx, sourceId)) !== 'open') throw posErrors.orderClosed();
      const table = await tx.diningTable.findUnique({
        where: { id: body.tableId },
        select: { id: true, locationId: true, archivedAt: true },
      });
      if (!table) throw posErrors.tableNotFound();
      if (table.locationId !== source.locationId) throw posErrors.orderNotSameLocation();
      if (table.archivedAt !== null) throw posErrors.tableArchived();
      const occupied = await tx.posOrder.findFirst({
        where: { tableId: table.id, status: 'open' },
        select: { id: true },
      });
      if (occupied) throw posErrors.tableOccupied();

      const portions = await this.takeOff(tx, sourceId, body.lines);
      await this.writeTickets(
        tx,
        sourceId,
        'void',
        { transferred: true },
        portions.map(({ line, quantity, station, direct }) => ({
          station,
          direct,
          line: {
            productId: line.productId,
            productName: line.productName,
            unitPrice: line.unitPrice.toFixed(2),
            taxRate: line.taxRate.toFixed(2),
            quantity: -quantity,
            note: null,
            voidsLineId: line.id,
            seat: line.seat,
          },
        })),
      );

      // As late as possible: the counter row stays locked until commit (ADR 0012).
      const { number } = await this.numbering.next('pos.order', tx);
      const created = await tx.posOrder.create({
        data: {
          tenantId,
          locationId: table.locationId,
          tableId: table.id,
          number,
          openedByUserId: userId,
        },
        select: ORDER_SELECT,
      });
      await this.audit.record(tx, {
        action: 'pos.order.transferred',
        actor: auditActor.user(userId),
        entityId: created.id,
        after: orderSnapshot(created),
      });
      // A party sits at the new table: consumers (reservations) react through the outbox (ADR 0019 §7).
      await this.outbox.add(tx, {
        type: 'pos.order.opened',
        payload: {
          orderId: created.id,
          locationId: table.locationId,
          tableId: table.id,
          openedAt: created.openedAt.toISOString(),
        },
      });
      const processing = await this.processing(table.locationId, tx);
      await this.writeTickets(
        tx,
        created.id,
        'order',
        { transferred: true },
        portions.map(({ line, quantity, station }) => ({
          station,
          direct: !processing[station],
          line: {
            productId: line.productId,
            productName: line.productName,
            unitPrice: line.unitPrice.toFixed(2),
            taxRate: line.taxRate.toFixed(2),
            quantity,
            note: null,
            voidsLineId: null,
            seat: line.seat,
          },
        })),
      );
      const response = {
        source: await this.load(tx, sourceId),
        target: await this.load(tx, created.id),
      };
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /**
   * The sent portions that `requested` takes off an order (a void or a transfer): each line must be sent, within what
   * is left, unbilled, and without a discount (ADR 0036 §5). Each comes with its ticket's station: a void goes where
   * the item went, straight to the bill when it did (ADR 0031).
   */
  private async takeOff(
    tx: TenantTransactionClient,
    orderId: string,
    requested: readonly { lineId: string; quantity: number }[],
  ) {
    const placedTicketIds = ticketIdsOf(await currentOrderByTicket(tx, [orderId]), orderId);
    const lines = await tx.posOrderLine.findMany({
      where: { ticketId: { in: placedTicketIds } },
      select: LINE_SELECT,
    });
    const left = remainingOf(lines);
    const sentLines = new Map(lines.filter((l) => l.quantity > 0).map((l) => [l.id, l]));
    const wanted = new Map<string, number>();
    for (const { lineId, quantity } of requested) {
      if (!sentLines.has(lineId)) throw posErrors.lineNotFound();
      wanted.set(lineId, (wanted.get(lineId) ?? 0) + quantity);
    }
    for (const [lineId, quantity] of wanted) {
      if (quantity > (left.get(lineId) ?? 0)) throw posErrors.voidExceeds(lineId);
    }
    // Only unbilled portions: a billed item moves after its bill is cancelled (ADR 0036).
    const unbilled = unbilledOf(left, await this.billed(tx, orderId));
    for (const [lineId, quantity] of wanted) {
      if (quantity > (unbilled.get(lineId) ?? 0)) throw posErrors.lineBilled(lineId);
    }
    // A discounted item can't move until its discount is removed (ADR 0036 §5).
    const discounted = (await activeDiscounts(tx, orderId)).lineAmount;
    for (const lineId of wanted.keys()) {
      if (discounted.has(lineId)) throw posErrors.discountActive();
    }
    const sentTickets = new Map(
      (
        await tx.posKitchenTicket.findMany({
          where: { id: { in: placedTicketIds } },
          select: { id: true, station: true, direct: true },
        })
      ).map((t) => [t.id, t]),
    );
    return [...wanted].map(([lineId, quantity]) => {
      const line = sentLines.get(lineId)!;
      const sent = sentTickets.get(line.ticketId)!;
      return { line, quantity, station: sent.station, direct: sent.direct };
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

  /**
   * Moves an open order to a free table at its location (ADR 0069). Only the order's table changes: no ticket is
   * written, so the kitchen is not reprinted. Moving to the table it is on changes nothing.
   */
  async move(orderId: string, body: MoveOrderRequest): Promise<Order> {
    const { userId } = this.tenantContext.require();
    const order = await this.readableOrder(orderId);
    await this.access.assert('pos.orders.take', { locationId: order.locationId });
    try {
      return await this.db.$transaction(async (tx) => {
        if ((await this.lockOrder(tx, orderId)) !== 'open') throw posErrors.orderClosed();
        const target = await tx.diningTable.findUnique({
          where: { id: body.tableId },
          select: { id: true, locationId: true, archivedAt: true },
        });
        if (!target) throw posErrors.tableNotFound();
        const before = await tx.posOrder.findUniqueOrThrow({
          where: { id: orderId },
          select: ORDER_SELECT,
        });
        if (target.locationId !== before.locationId) throw posErrors.orderNotSameLocation();
        if (target.archivedAt !== null) throw posErrors.tableArchived();
        if (before.tableId === target.id) return this.load(tx, orderId);
        const occupied = await tx.posOrder.findFirst({
          where: { tableId: target.id, status: 'open' },
          select: { id: true },
        });
        if (occupied) throw posErrors.tableOccupied();
        const after = await tx.posOrder.update({
          where: { id: orderId },
          data: { tableId: target.id },
          select: ORDER_SELECT,
        });
        await this.audit.record(tx, {
          action: 'pos.order.moved',
          actor: auditActor.user(userId),
          entityId: orderId,
          before: orderSnapshot(before),
          after: orderSnapshot(after),
        });
        await this.changed(tx, after);
        return this.load(tx, orderId);
      });
    } catch (error) {
      // Two moves to the same free table at once: the partial unique index on open orders decides.
      if (isUniqueViolation(error)) throw posErrors.tableOccupied();
      throw error;
    }
  }

  /**
   * Merges the open order `sourceId` into the open order `body.orderId` at the same location (ADR 0069). Each of the
   * source's tickets gets a placement in the target, so its lines follow it; the source closes (`pos.order.merged`)
   * and its table is freed through `pos.order.closed`. The target keeps its number. Refused when the source has billed
   * items or an active discount, which would stay on the source.
   */
  async merge(sourceId: string, body: MergeOrderRequest): Promise<Order> {
    const { tenantId, userId } = this.tenantContext.require();
    if (body.orderId === sourceId) throw posErrors.mergeSameOrder();
    const source = await this.readableOrder(sourceId);
    await this.access.assert('pos.orders.take', { locationId: source.locationId });
    const target = await this.readableOrder(body.orderId);
    if (target.locationId !== source.locationId) throw posErrors.orderNotSameLocation();
    return this.db.$transaction(async (tx) => {
      // Locked in id order, so two merges in opposite directions cannot wait on each other.
      for (const id of [sourceId, body.orderId].sort()) {
        if ((await this.lockOrder(tx, id)) !== 'open') throw posErrors.orderClosed();
      }
      const billed = await tx.posBillItem.findFirst({
        where: { orderId: sourceId, bill: { cancellation: null } },
        select: { orderLineId: true },
      });
      if (billed) throw posErrors.lineBilled(billed.orderLineId);
      if ((await activeDiscounts(tx, sourceId)).rows.length > 0) throw posErrors.discountActive();

      const before = await tx.posOrder.findUniqueOrThrow({
        where: { id: sourceId },
        select: ORDER_SELECT,
      });
      const tickets = [...(await currentOrderByTicket(tx, [sourceId])).keys()];
      if (tickets.length > 0) {
        await tx.posTicketPlacement.createMany({
          data: tickets.map((ticketId) => ({
            tenantId,
            ticketId,
            orderId: body.orderId,
            createdByUserId: userId,
          })),
        });
      }
      const after = await tx.posOrder.update({
        where: { id: sourceId },
        data: { status: 'closed', closedAt: new Date(), closedByUserId: userId },
        select: ORDER_SELECT,
      });
      await this.audit.record(tx, {
        action: 'pos.order.merged',
        actor: auditActor.user(userId),
        entityId: sourceId,
        before: orderSnapshot(before),
        after: orderSnapshot(after),
      });
      // The source's table is free now: consumers react as to a close (ADR 0019 §7).
      await this.outbox.add(tx, {
        type: 'pos.order.closed',
        payload: { orderId: sourceId, locationId: after.locationId, tableId: after.tableId },
      });
      await this.changed(tx, { id: body.orderId, locationId: after.locationId });
      const response = await this.load(tx, body.orderId);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
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

  /**
   * Products that can be ordered (not archived, category not archived) at the price the location
   * charges now (catalog's price rules, ADR 0030), or 409 naming the rest.
   */
  private async availableProducts(tx: TenantTransactionClient, ids: string[], locationId: string) {
    const { products, missing } = await this.pricing.orderableProducts(tx, ids, {
      locationId,
      at: this.clock.now(),
    });
    if (missing.length > 0) throw posErrors.productUnavailable(missing);
    return products;
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
    await this.changed(tx, after);
  }

  /** Tells consumers (reports, ADR 0081) that the order changed in a way no other event tells. */
  private async changed(
    tx: TenantTransactionClient,
    order: { id: string; locationId: string },
  ): Promise<void> {
    await this.outbox.add(tx, {
      type: 'pos.order.updated',
      payload: { orderId: order.id, locationId: order.locationId },
    });
  }

  /** A send or void response: the order and its new tickets in sequence order (ADR 0025). */
  private async response(
    tx: TenantTransactionClient,
    orderId: string,
    ticketIds: string[],
  ): Promise<SendTicketResponse> {
    // Tickets a printer of the location prints (ADR 0033): the sending device leaves them to the till.
    const queued = await tx.posPrintJob.findMany({
      where: { ticketId: { in: ticketIds } },
      select: { ticketId: true },
      distinct: ['ticketId'],
    });
    const printQueuedIds = ticketIds.filter((id) => queued.some((q) => q.ticketId === id));
    return {
      order: await this.load(tx, orderId),
      ticketId: ticketIds[0]!,
      ticketIds,
      printQueuedIds,
    };
  }

  /**
   * One ticket per station the lines go to, kitchen first, in the lines' order within each
   * (ADR 0025); prepared items before direct ones of the same station (ADR 0031). Returns the
   * ticket ids in sequence order.
   */
  private async writeTickets(
    tx: TenantTransactionClient,
    orderId: string,
    kind: 'order' | 'void',
    origin: TicketOrigin,
    lines: { station: PrepStation; direct: boolean; line: TicketLine }[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const station of STATION_ORDER) {
      for (const direct of [false, true]) {
        const group = lines
          .filter((l) => l.station === station && l.direct === direct)
          .map((l) => l.line);
        if (group.length > 0) {
          ids.push(
            await this.writeTicket(tx, orderId, kind, { station, direct, ...origin }, group),
          );
        }
      }
    }
    return ids;
  }

  /** The next ticket of a locked order with its lines, audited. Returns the ticket id. */
  private async writeTicket(
    tx: TenantTransactionClient,
    orderId: string,
    kind: 'order' | 'void',
    { station, direct, ...origin }: { station: PrepStation; direct: boolean } & TicketOrigin,
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
        direct,
        ...origin,
        createdByUserId: userId,
      },
      select: { id: true, orderId: true, sequence: true, kind: true, station: true, direct: true },
    });
    const written = await tx.posOrderLine.createManyAndReturn({
      data: lines.map((line) => ({
        ...line,
        tenantId,
        orderId,
        ticketId: ticket.id,
        createdByUserId: userId,
      })),
      select: { id: true, productId: true, quantity: true },
    });
    await this.audit.record(tx, {
      action: 'pos.kitchen_ticket.created',
      actor: auditActor.user(userId),
      entityId: ticket.id,
      after: snapshot('kitchen_ticket', { ...ticket, lineCount: lines.length }),
    });
    // Consumers (inventory books the dishes' ingredients) react through the outbox (ADR 0028).
    const { locationId } = await tx.posOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { locationId: true },
    });
    await this.outbox.add(tx, {
      type: 'pos.kitchen_ticket.created',
      payload: {
        ticketId: ticket.id,
        orderId,
        locationId,
        station,
        kind,
        createdByUserId: userId,
        lines: written.map((l) => ({ lineId: l.id, productId: l.productId, quantity: l.quantity })),
      },
    });
    // On paper at the station's printers (ADR 0033); a ticket straight to the bill prints nowhere.
    if (!direct) {
      await this.printJobs.queueTicket(tx, { id: ticket.id, orderId, locationId, station });
    }
    return ticket.id;
  }

  /** The full order: tickets in order, their lines with what is left, and totals. */
  private async load(db: Db, orderId: string): Promise<Order> {
    const { openedByUserId, ...order } = await db.posOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { ...ORDER_SELECT, openedByUserId: true },
    });
    const ticketIds = ticketIdsOf(await currentOrderByTicket(db, [orderId]), orderId);
    const [tickets, lines, names, billed, bills] = await Promise.all([
      db.posKitchenTicket.findMany({
        where: { id: { in: ticketIds } },
        select: {
          id: true,
          sequence: true,
          kind: true,
          station: true,
          direct: true,
          createdAt: true,
          statusChanges: LATEST_STATUS,
        },
        orderBy: { sequence: 'asc' },
      }),
      db.posOrderLine.findMany({
        where: { ticketId: { in: ticketIds } },
        select: LINE_SELECT,
        orderBy: { id: 'asc' },
      }),
      this.memberNames.forUsers(db, [openedByUserId]),
      this.billed(db, orderId),
      db.posBillOrder.findMany({
        where: { orderId },
        select: {
          bill: {
            select: {
              id: true,
              kind: true,
              shareCount: true,
              createdAt: true,
              cancellation: { select: { createdAt: true } },
              checks: {
                select: { id: true, number: true, shareIndex: true, gross: true },
                orderBy: { shareIndex: 'asc' },
              },
            },
          },
        },
        orderBy: { billId: 'asc' },
      }),
    ]);
    const left = remainingOf(lines);
    const unbilled = unbilledOf(left, billed);
    const active = await activeDiscounts(db, orderId);
    const discounts = active.lineAmount;
    const totals = orderTotals(lines.map(priced));
    const byTicket = new Map<string, OrderLine[]>();
    for (const line of lines) {
      const list = byTicket.get(line.ticketId) ?? [];
      const remaining = left.get(line.id) ?? 0;
      list.push(lineResponse(line, remaining, remaining - (unbilled.get(line.id) ?? 0)));
      byTicket.set(line.ticketId, list);
    }
    const ticketList: KitchenTicket[] = tickets.map((t) => ({
      id: t.id,
      sequence: t.sequence,
      kind: t.kind,
      station: t.station,
      status: statusOf(t.statusChanges),
      direct: t.direct,
      createdAt: t.createdAt.toISOString(),
      lines: byTicket.get(t.id) ?? [],
    }));
    return {
      ...summaryOf(
        order,
        totals.itemCount,
        totals.gross,
        readyCount(ticketList),
        discountedUnbilled(
          unbilledGross(
            lines.map((l) => ({ id: l.id, unitPrice: l.unitPrice.toFixed(2) })),
            unbilled,
          ),
          unbilled,
          discounts,
        ),
      ),
      tickets: ticketList,
      totals,
      waiterName: names.get(openedByUserId) ?? null,
      discounts: active.rows.map((d) => ({
        id: d.id,
        orderLineId: d.orderLineId,
        kind: d.kind,
        value: d.value,
        reason: d.reason,
        amount: d.amount,
        voided: false,
        createdAt: d.createdAt.toISOString(),
      })),
      bills: bills.map(({ bill }) => ({
        id: bill.id,
        kind: bill.kind,
        shareCount: bill.shareCount,
        createdAt: bill.createdAt.toISOString(),
        cancelled: bill.cancellation !== null,
        checks: bill.checks.map((c) => ({
          id: c.id,
          number: c.number,
          shareIndex: c.shareIndex === 0 ? null : c.shareIndex,
          gross: c.gross.toFixed(2),
        })),
      })),
    };
  }

  /** When each order's newest ticket was sent, for the orders in `orderIds` that have one (ADR 0069). */
  private async lastTicketAt(db: Db, orderIds: readonly string[]): Promise<Map<string, string>> {
    const byTicket = await currentOrderByTicket(db, orderIds);
    const tickets = await db.posKitchenTicket.findMany({
      where: { id: { in: [...byTicket.keys()] } },
      select: { id: true, createdAt: true },
    });
    const latest = new Map<string, Date>();
    for (const ticket of tickets) {
      const order = byTicket.get(ticket.id);
      if (!order) continue;
      const seen = latest.get(order);
      if (!seen || ticket.createdAt > seen) latest.set(order, ticket.createdAt);
    }
    return new Map([...latest].map(([order, at]) => [order, at.toISOString()]));
  }

  /** Portions of each line of the order on bills that are not cancelled (ADR 0036). */
  private async billed(db: Db, orderId: string): Promise<Map<string, number>> {
    return billedByLine(
      await db.posBillItem.findMany({
        where: { orderId, bill: { cancellation: null } },
        select: { orderLineId: true, quantity: true },
      }),
    );
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
    const byTicket = await currentOrderByTicket(db, ids);
    const ticketIds = [...byTicket.keys()];
    const [lines, tickets, billedItems] = await Promise.all([
      db.posOrderLine.findMany({
        where: { ticketId: { in: ticketIds } },
        select: {
          id: true,
          ticketId: true,
          unitPrice: true,
          taxRate: true,
          quantity: true,
          voidsLineId: true,
        },
      }),
      db.posKitchenTicket.findMany({
        where: { id: { in: ticketIds } },
        select: { id: true, statusChanges: LATEST_STATUS },
      }),
      db.posBillItem.findMany({
        where: { orderId: { in: ids }, bill: { cancellation: null } },
        select: { orderLineId: true, quantity: true },
      }),
    ]);
    const unbilled = unbilledOf(remainingOf(lines), billedByLine(billedItems));
    const discountsOf = new Map(
      await Promise.all(
        ids.map(async (id) => [id, (await activeDiscounts(db, id)).lineAmount] as const),
      ),
    );
    const ready = new Map<string, number>();
    for (const t of tickets) {
      const order = byTicket.get(t.id);
      if (order && statusOf(t.statusChanges) === 'ready')
        ready.set(order, (ready.get(order) ?? 0) + 1);
    }
    const byOrder = new Map<string, (typeof lines)[number][]>();
    for (const line of lines) {
      const order = byTicket.get(line.ticketId);
      if (order) byOrder.set(order, [...(byOrder.get(order) ?? []), line]);
    }
    return orders.map((order) => {
      const own = byOrder.get(order.id) ?? [];
      const totals = orderTotals(own.map(priced));
      return summaryOf(
        order,
        totals.itemCount,
        totals.gross,
        ready.get(order.id) ?? 0,
        discountedUnbilled(
          unbilledGross(
            own.map((l) => ({ id: l.id, unitPrice: l.unitPrice.toFixed(2) })),
            unbilled,
          ),
          unbilled,
          discountsOf.get(order.id) ?? new Map(),
        ),
      );
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

function priced(line: Pick<LineRow, 'unitPrice' | 'taxRate' | 'quantity'>) {
  return {
    unitPrice: line.unitPrice.toFixed(2),
    taxRate: line.taxRate.toFixed(2),
    quantity: line.quantity,
  };
}

function lineResponse(line: LineRow, remaining: number, billedQuantity: number): OrderLine {
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
    seat: line.seat,
    remaining: line.quantity > 0 ? remaining : 0,
    billedQuantity: line.quantity > 0 ? billedQuantity : 0,
    total: lineTotal(unitPrice, line.quantity),
    createdAt: line.createdAt.toISOString(),
  };
}

/** Tickets ready to serve (ADR 0026). */
function readyCount(tickets: readonly KitchenTicket[]): number {
  return tickets.filter((t) => t.status === 'ready').length;
}

function summaryOf(
  order: OrderRow,
  itemCount: number,
  gross: string,
  ready: number,
  unbilled: string,
): OrderSummary {
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
    unbilled,
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

/** The gross still to bill, less the discounts on the lines still to bill (ADR 0036 §5). */
function discountedUnbilled(
  gross: string,
  unbilled: ReadonlyMap<string, number>,
  discounts: ReadonlyMap<string, Decimal>,
): string {
  let total = new Decimal(gross);
  for (const [lineId, amount] of discounts) {
    if ((unbilled.get(lineId) ?? 0) > 0) total = total.plus(amount);
  }
  return total.toFixed(2);
}
