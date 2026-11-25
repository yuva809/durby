import { z } from 'zod';
import { PREP_STATIONS } from '../api/catalog';
import { KITCHEN_TICKET_KINDS, TICKET_STATUSES } from '../api/pos-orders';

/**
 * pos events (docs/modules/pos.md → Events). Written by pos in the change's transaction; pos never
 * imports their consumers.
 */

/**
 * Something about an order changed that no other event tells: its covers, table (move), discounts, or tickets merged
 * into it. Consumers read the order's current state (reports, ADR 0081).
 */
export const posOrderUpdatedV1 = z.strictObject({ orderId: z.uuid(), locationId: z.uuid() });

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

/**
 * A send or void wrote a kitchen or bar ticket (POST /pos/tables/:id/tickets, /pos/orders/:id/voids;
 * one event per ticket). First consumer: inventory books the ingredients of the dishes as a
 * consumption (docs/modules/inventory.md → Consumption, ADR 0028). Quantities are signed: negative on
 * a void ticket.
 */
export const posKitchenTicketCreatedV1 = z.strictObject({
  ticketId: z.uuid(),
  orderId: z.uuid(),
  locationId: z.uuid(),
  station: z.enum(PREP_STATIONS),
  kind: z.enum(KITCHEN_TICKET_KINDS),
  /** Who sent it: the consumption document's creator. */
  createdByUserId: z.uuid(),
  lines: z
    .array(z.strictObject({ lineId: z.uuid(), productId: z.uuid(), quantity: z.int() }))
    .min(1),
});

/**
 * A kitchen or bar ticket moved on its station or was served from the till. `orderId`: the order it is on now (ADR
 * 0069). First consumer: live updates of the floor, which shows what is ready (ADR 0044).
 */
export const posKitchenTicketStatusChangedV1 = z.strictObject({
  ticketId: z.uuid(),
  orderId: z.uuid(),
  locationId: z.uuid(),
  status: z.enum(TICKET_STATUSES),
});
