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
