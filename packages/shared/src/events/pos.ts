import { z } from 'zod';

/**
 * pos events (docs/modules/pos.md → Events). Written by pos in the change's transaction; pos never
 * imports their consumers.
 */

/**
 * An open order was closed, so its table is free (`POST /pos/orders/:id/close`; closing a closed
 * order writes nothing). First consumer: reservations finishes the seated booking on that table
 * (docs/modules/reservations.md, ADR 0019).
 */
export const posOrderClosedV1 = z.strictObject({
  orderId: z.uuid(),
  locationId: z.uuid(),
  tableId: z.uuid(),
});

/**
 * A send opened an order on a table (POST /pos/tables/:id/tickets when the table had none). First
 * consumer: reservations auto-seats the booking expected at that table (docs/modules/reservations.md
 * → R1.7, restaurants without a host). pos never imports its consumers.
 */
export const posOrderOpenedV1 = z.strictObject({
  orderId: z.uuid(),
  locationId: z.uuid(),
  tableId: z.uuid(),
  /** pos_orders.opened_at, UTC. */
  openedAt: z.iso.datetime(),
});
