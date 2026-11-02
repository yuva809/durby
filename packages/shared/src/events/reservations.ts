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
