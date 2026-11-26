import { z } from 'zod';
import { RESERVATION_STATUSES } from '../api/reservations';

/**
 * reservations events (docs/modules/reservations.md → Integration with pos). Ids, enums and the
 * start only: never guest data or notes. No consumer in R1; realtime fan-out in RT.1.
 */
const reservationV1 = z.strictObject({
  reservationId: z.uuid(),
  locationId: z.uuid(),
  status: z.enum(RESERVATION_STATUSES),
  startsAt: z.iso.datetime(),
});

export const reservationsReservationCreatedV1 = reservationV1;
export const reservationsReservationUpdatedV1 = reservationV1;
/** A status action or an undo; `status` is the new one. */
export const reservationsReservationStatusChangedV1 = reservationV1;

/** A waitlist entry was added, changed, told, seated or ended (ADR 0084): live updates of the host screen. */
export const reservationsWaitlistChangedV1 = z.strictObject({
  entryId: z.uuid(),
  locationId: z.uuid(),
});

/**
 * A pending online booking's confirmation time ran out (R2.3b), written delayed by
 * `reservations.online.pendingExpiryMinutes` (R2.0). The handler expires it only if it is still pending.
 */
export const reservationsPendingExpiryDueV1 = z.strictObject({
  reservationId: z.uuid(),
  locationId: z.uuid(),
});
