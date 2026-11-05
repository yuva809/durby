import type { ReservationsFloorResponse } from '@durby/shared';
import type { Session } from '../auth/session';
import { clockTime } from './host';

/**
 * What the pos floor and the till show from reservations (docs/modules/reservations.md → Web,
 * R1.9; G5: composed here, pos never reads reservations).
 */
export interface ServiceBadge {
  /** A seated booking's party on the table: the till pre-fills covers with it. */
  seatedParty: number | null;
  /** The table's next booking today: "19:30 · 4 p.". */
  next: { time: string; partySize: number } | null;
}

/** Only with the feature and the read key; without them /service works as before. */
export const reservationsVisible = (session: Session | null): boolean =>
  !!session &&
  session.activeFeatures.includes('reservations') &&
  session.activePermissions.includes('reservations.bookings.read');

export function serviceBadges(floor: ReservationsFloorResponse): Map<string, ServiceBadge> {
  return new Map(
    floor.data.map((table) => [
      table.id,
      {
        seatedParty:
          table.state === 'occupied' && table.current?.reservationId
            ? table.current.partySize
            : null,
        next: table.next
          ? {
              time: clockTime(table.next.startsAt, floor.timeZone),
              partySize: table.next.partySize,
            }
          : null,
      },
    ]),
  );
}
