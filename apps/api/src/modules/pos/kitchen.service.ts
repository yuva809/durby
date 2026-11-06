import { Inject, Injectable } from '@nestjs/common';
import type {
  Order,
  PermissionKey,
  PrepStation,
  StationTicket,
  TicketStatus,
  TicketStatusRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { OrdersService } from './orders.service';
import { posErrors } from './pos-errors';
import { canMove, LATEST_STATUS, statusOf } from './ticket-status';

/** Served tickets stay on the board this long, so a wrong tap can be undone. */
const SERVED_VISIBLE_MS = 15 * 60_000;
/** Older tickets of closed orders are history, not work. */
const BOARD_HORIZON_MS = 12 * 60 * 60_000;

const STATION_KEYS: Record<PrepStation, PermissionKey> = {
  kitchen: 'pos.kitchen.use',
  bar: 'pos.bar.use',
};

const TICKET_SELECT = {
  id: true,
  orderId: true,
  sequence: true,
  kind: true,
  station: true,
  createdAt: true,
  order: { select: { number: true, locationId: true, table: { select: { name: true } } } },
  lines: {
    select: { id: true, productName: true, quantity: true, note: true },
    orderBy: { id: 'asc' },
  },
  statusChanges: LATEST_STATUS,
} as const;

type TicketRow = {
  id: string;
  orderId: string;
  sequence: number;
  kind: 'order' | 'void';
  station: PrepStation;
  createdAt: Date;
  order: { number: string; locationId: string; table: { name: string } };
  lines: { id: string; productName: string; quantity: number; note: string | null }[];
  statusChanges: { status: Exclude<TicketStatus, 'new'>; createdAt: Date }[];
};

/**
 * The kitchen and bar screens (docs/modules/pos.md → Kitchen and bar screens, ADR 0026): a
 * station's tickets with their status, and moves. Status changes are append-only (rule 7); a
 * ticket's status is its latest change. Keys are location-scoped and checked at the ticket's
 * order's location: a ticket the caller can't see doesn't exist for them (404).
 */
@Injectable()
export class KitchenService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly orders: OrdersService,
  ) {}

  /** The station's tickets at the location: not served, or served in the last 15 minutes. */
  async board(station: PrepStation, locationId: string): Promise<StationTicket[]> {
    const location = await this.db.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location || !(await this.access.can(STATION_KEYS[station], { locationId }))) {
      throw posErrors.locationNotFound();
    }
    const now = Date.now();
    const rows: TicketRow[] = await this.db.posKitchenTicket.findMany({
      where: {
        station,
        // Items that went straight to the bill are not work for the station (ADR 0031).
        direct: false,
        order: { locationId },
        OR: [
          { order: { status: 'open' } },
          { createdAt: { gte: new Date(now - BOARD_HORIZON_MS) } },
        ],
      },
      select: TICKET_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows
      .map(ticketResponse)
      .filter((t) => t.status !== 'served' || now - Date.parse(t.statusAt) < SERVED_VISIBLE_MS);
  }

  /** Moves a ticket on its station's screen. */
  async move(
    station: PrepStation,
    ticketId: string,
    body: TicketStatusRequest,
  ): Promise<StationTicket> {
    const ticket = await this.visibleTicket(ticketId, STATION_KEYS[station]);
    if (ticket.station !== station) throw posErrors.ticketNotFound();
    // Straight to the bill: nothing to prepare (ADR 0031).
    if (ticket.direct) throw posErrors.ticketStatusInvalid(body.status);
    return this.db.$transaction(async (tx) => {
      const row = await this.change(tx, ticketId, body.status);
      const response = ticketResponse(row);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /**
   * A waiter serves a ready ticket from the till (`pos.orders.take`). Only `ready → served`;
   * the station's screen does everything else.
   */
  async serve(orderId: string, ticketId: string): Promise<Order> {
    const ticket = await this.visibleTicket(ticketId, 'pos.orders.read');
    if (ticket.orderId !== orderId) throw posErrors.ticketNotFound();
    await this.access.assert('pos.orders.take', { locationId: ticket.order.locationId });
    if (ticket.direct) throw posErrors.ticketStatusInvalid('served');
    return this.db.$transaction(async (tx) => {
      const current = await this.lockedStatus(tx, ticket);
      if (current !== 'ready' && current !== 'served')
        throw posErrors.ticketStatusInvalid('served');
      await this.change(tx, ticketId, 'served');
      const response = await this.orders.orderIn(tx, orderId);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** The ticket, if it exists here and the caller holds `key` at its order's location. */
  private async visibleTicket(ticketId: string, key: PermissionKey) {
    const ticket = await this.db.posKitchenTicket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        orderId: true,
        station: true,
        kind: true,
        direct: true,
        order: { select: { locationId: true } },
      },
    });
    if (!ticket || !(await this.access.can(key, { locationId: ticket.order.locationId }))) {
      throw posErrors.ticketNotFound();
    }
    return ticket;
  }

  /** Locks the ticket's order (moves on one order are serialized) and reads the ticket's status. */
  private async lockedStatus(
    tx: TenantTransactionClient,
    ticket: { id: string; orderId: string },
  ): Promise<TicketStatus> {
    await tx.$queryRaw`SELECT id FROM pos_orders WHERE id = ${ticket.orderId}::uuid FOR UPDATE`;
    const latest = await tx.posTicketStatusChange.findMany({
      where: { ticketId: ticket.id },
      ...LATEST_STATUS,
    });
    return statusOf(latest);
  }

  /**
   * Appends the change and its audit row; the current status again writes nothing, a move the
   * rules don't allow is 409. Returns the ticket as it is now.
   */
  private async change(
    tx: TenantTransactionClient,
    ticketId: string,
    to: Exclude<TicketStatus, 'new'>,
  ): Promise<TicketRow> {
    const { tenantId, userId } = this.tenantContext.require();
    const before: TicketRow = await tx.posKitchenTicket.findUniqueOrThrow({
      where: { id: ticketId },
      select: TICKET_SELECT,
    });
    const from = await this.lockedStatus(tx, before);
    if (from === to) return before;
    if (!canMove(before.kind, from, to)) throw posErrors.ticketStatusInvalid(to);
    await tx.posTicketStatusChange.create({
      data: { tenantId, ticketId, status: to, changedByUserId: userId },
    });
    await this.audit.record(tx, {
      action: 'pos.kitchen_ticket.status_changed',
      actor: auditActor.user(userId),
      entityId: ticketId,
      before: snapshot('kitchen_ticket', { id: ticketId, sequence: before.sequence, status: from }),
      after: snapshot('kitchen_ticket', { id: ticketId, sequence: before.sequence, status: to }),
    });
    return tx.posKitchenTicket.findUniqueOrThrow({
      where: { id: ticketId },
      select: TICKET_SELECT,
    });
  }
}

function ticketResponse(row: TicketRow): StationTicket {
  const latest = row.statusChanges[0];
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.number,
    tableName: row.order.table.name,
    sequence: row.sequence,
    kind: row.kind,
    status: statusOf(row.statusChanges),
    createdAt: row.createdAt.toISOString(),
    statusAt: (latest?.createdAt ?? row.createdAt).toISOString(),
    lines: row.lines,
  };
}
