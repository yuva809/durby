import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { TenantDb } from '../../platform/tenancy';
import { remainingOf } from './billing';
import { currentOrdersOf } from './ticket-placements';

/** One sent line, net of its voids and discounts; lines with nothing left are not listed. */
export interface SoldLine {
  lineId: string;
  productId: string;
  /** Sent minus voided, above 0. */
  quantity: number;
  /** Quantity × unit price plus discounts (negative), two decimals. */
  gross: string;
  sentAt: Date;
}

/** An order for the reports (ADR 0081): numbers and ids only. */
export interface OrderFacts {
  orderId: string;
  locationId: string;
  tableId: string;
  openedAt: Date;
  closedAt: Date | null;
  covers: number | null;
  /** Closed by a merge: every ticket sent on it belongs to another order now. */
  mergedAway: boolean;
  /** Sends with a line left; one send's kitchen and bar tickets are one round, a transfer is none. */
  rounds: number;
  lines: SoldLine[];
}

/** Tickets from before send ids: those of one order written this close together were one send. */
const LEGACY_SEND_MS = 2_000;

/**
 * pos's read port for the reports (docs/modules/reports.md, ADR 0081), in the caller's transaction and tenant (RLS); it
 * checks no permission keys. Lines are read by the order they were **sent** on: a merge moves a ticket's placement, not
 * the sale, so nothing counts twice. Voids and discounts are found by line, whichever order they are on (ADR 0069).
 */
@Injectable()
export class PosSalesReader {
  /** The orders that exist, with what was sold on them. */
  async orderFacts(orderIds: readonly string[], db: TenantDb): Promise<OrderFacts[]> {
    if (orderIds.length === 0) return [];
    const ids = [...orderIds];
    const orders = await db.posOrder.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        locationId: true,
        tableId: true,
        status: true,
        openedAt: true,
        closedAt: true,
        covers: true,
      },
      orderBy: { id: 'asc' },
    });
    const tickets = await db.posKitchenTicket.findMany({
      where: { orderId: { in: ids } },
      select: {
        id: true,
        orderId: true,
        kind: true,
        sendId: true,
        transferred: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const sent = await db.posOrderLine.findMany({
      where: { orderId: { in: ids }, quantity: { gt: 0 } },
      select: {
        id: true,
        orderId: true,
        ticketId: true,
        productId: true,
        unitPrice: true,
        quantity: true,
        voidsLineId: true,
      },
      orderBy: { id: 'asc' },
    });
    const lineIds = sent.map((l) => l.id);
    const voids = await db.posOrderLine.findMany({
      where: { voidsLineId: { in: lineIds } },
      select: { id: true, quantity: true, voidsLineId: true },
    });
    const discounts = await discountByLine(db, lineIds);
    const placed = await currentOrdersOf(
      db,
      tickets.map((t) => t.id),
    );
    const left = remainingOf([...sent, ...voids]);
    const ticketOf = new Map(tickets.map((t) => [t.id, t]));

    return orders.map((order) => {
      const own = tickets.filter((t) => t.orderId === order.id);
      const lines = sent
        .filter((l) => l.orderId === order.id)
        .flatMap((l): SoldLine[] => {
          const quantity = left.get(l.id) ?? 0;
          const ticket = ticketOf.get(l.ticketId);
          if (quantity <= 0 || !ticket) return [];
          const gross = new Decimal(l.unitPrice.toFixed(2))
            .times(quantity)
            .plus(discounts.get(l.id) ?? 0);
          return [
            {
              lineId: l.id,
              productId: l.productId,
              quantity,
              gross: gross.toFixed(2),
              sentAt: ticket.createdAt,
            },
          ];
        });
      const sold = new Set(lines.map((l) => l.lineId));
      const soldTickets = new Set(sent.filter((l) => sold.has(l.id)).map((l) => l.ticketId));
      return {
        orderId: order.id,
        locationId: order.locationId,
        tableId: order.tableId,
        openedAt: order.openedAt,
        closedAt: order.closedAt,
        covers: order.covers,
        mergedAway:
          order.status === 'closed' &&
          own.length > 0 &&
          own.every((t) => (placed.get(t.id) ?? order.id) !== order.id),
        rounds: roundsOf(
          own.filter((t) => t.kind === 'order' && !t.transferred && soldTickets.has(t.id)),
        ),
        lines,
      };
    });
  }

  /**
   * The order and every order whose tickets were ever placed on it: a void or discount on a merged order changes what
   * was sold on the order the item was sent on.
   */
  async relatedOrders(orderId: string, db: TenantDb): Promise<string[]> {
    const rows = await db.$queryRaw<{ order_id: string }[]>`
      SELECT DISTINCT t.order_id
      FROM pos_ticket_placements p
      JOIN pos_kitchen_tickets t ON t.id = p.ticket_id
      WHERE p.order_id = ${orderId}::uuid`;
    return [...new Set([orderId, ...rows.map((r) => r.order_id)])].sort();
  }

  /** Ids of orders opened from `from` on (all without it), after `after`, in id order. */
  async orderIds(
    page: { from?: Date | undefined; after?: string | undefined; take: number },
    db: TenantDb,
  ): Promise<string[]> {
    const rows = await db.posOrder.findMany({
      where: {
        ...(page.from ? { openedAt: { gte: page.from } } : {}),
        ...(page.after ? { id: { gt: page.after } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: page.take,
    });
    return rows.map((r) => r.id);
  }
}

/** Σ of the discounts of each line that no later row removed (negative). */
async function discountByLine(
  db: TenantDb,
  lineIds: readonly string[],
): Promise<Map<string, Decimal>> {
  const rows = await db.posOrderDiscountLine.findMany({
    where: { orderLineId: { in: [...lineIds] }, discount: { voidsDiscountId: null } },
    select: { orderLineId: true, discountId: true, amount: true },
  });
  const removed = new Set(
    (
      await db.posOrderDiscount.findMany({
        where: { voidsDiscountId: { in: [...new Set(rows.map((r) => r.discountId))] } },
        select: { voidsDiscountId: true },
      })
    ).map((r) => r.voidsDiscountId),
  );
  const sum = new Map<string, Decimal>();
  for (const row of rows) {
    if (removed.has(row.discountId)) continue;
    sum.set(
      row.orderLineId,
      (sum.get(row.orderLineId) ?? new Decimal(0)).plus(row.amount.toFixed(2)),
    );
  }
  return sum;
}

/** Distinct sends of an order's tickets (oldest first). */
export function roundsOf(tickets: readonly { sendId: string | null; createdAt: Date }[]): number {
  const sends = new Set(tickets.flatMap((t) => (t.sendId ? [t.sendId] : [])));
  let legacy = 0;
  let start = -Infinity;
  for (const ticket of tickets) {
    if (ticket.sendId) continue;
    const at = ticket.createdAt.getTime();
    if (at - start > LEGACY_SEND_MS) {
      legacy += 1;
      start = at;
    }
  }
  return sends.size + legacy;
}
