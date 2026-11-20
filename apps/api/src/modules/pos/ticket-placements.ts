import type { TenantDb } from '../../platform/tenancy/prisma-clients';

/**
 * The order each kitchen ticket belongs to now (ADR 0069): the ticket's latest placement. Only tickets whose
 * current order is in `orderIds` are returned. A line belongs to the order of its ticket, so every read that lists
 * an order's tickets or lines goes through this map, never through `pos_kitchen_tickets.order_id` or
 * `pos_order_lines.order_id`.
 *
 * Tenant rows only: the tenant client's RLS applies to the query.
 */
export async function currentOrderByTicket(
  db: Pick<TenantDb, '$queryRaw'>,
  orderIds: readonly string[],
): Promise<Map<string, string>> {
  const byTicket = new Map<string, string>();
  if (orderIds.length === 0) return byTicket;
  const rows = await db.$queryRaw<{ ticket_id: string; order_id: string }[]>`
    WITH candidates AS (
      SELECT DISTINCT ticket_id FROM pos_ticket_placements WHERE order_id = ANY(${orderIds}::uuid[])
    )
    SELECT ticket_id, order_id FROM (
      SELECT DISTINCT ON (p.ticket_id) p.ticket_id, p.order_id
      FROM pos_ticket_placements p
      JOIN candidates c ON c.ticket_id = p.ticket_id
      ORDER BY p.ticket_id, p.seq DESC
    ) latest
    WHERE order_id = ANY(${orderIds}::uuid[])`;
  for (const row of rows) byTicket.set(row.ticket_id, row.order_id);
  return byTicket;
}

/** The ids of the tickets whose current order is `orderId`. */
export function ticketIdsOf(byTicket: ReadonlyMap<string, string>, orderId: string): string[] {
  return [...byTicket].filter(([, order]) => order === orderId).map(([ticket]) => ticket);
}
