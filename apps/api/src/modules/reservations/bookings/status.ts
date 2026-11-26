import { RESERVATION_UNDO_WINDOW_MS, type ReservationStatus } from '@durby/shared';

/**
 * The staff status flow (docs/modules/reservations.md → Status flow, R1.6c): which action may move
 * a booking where, and which change may be undone. Pure: the caller passes `now`.
 */

export type StatusAction = 'arrive' | 'seat' | 'finish' | 'no_show' | 'cancel';

const FLOW: Record<StatusAction, { from: readonly ReservationStatus[]; to: ReservationStatus }> = {
  arrive: { from: ['booked'], to: 'arrived' },
  seat: { from: ['booked', 'arrived'], to: 'seated' },
  finish: { from: ['seated'], to: 'finished' },
  no_show: { from: ['booked', 'arrived'], to: 'no_show' },
  cancel: { from: ['pending', 'booked', 'arrived'], to: 'cancelled' },
};

/** How long a change can be undone. */
export const UNDO_WINDOW_MS = RESERVATION_UNDO_WINDOW_MS;

export type Transition =
  | { ok: true; to: ReservationStatus }
  | { ok: false; from: ReservationStatus; to: ReservationStatus };

export function transition(
  action: StatusAction,
  booking: { status: ReservationStatus; startsAt: Date },
  now: Date,
): Transition {
  const { from, to } = FLOW[action];
  const allowed =
    from.includes(booking.status) &&
    // A no-show only once the start has passed (Q5): no mis-taps on future bookings.
    (action !== 'no_show' || booking.startsAt.getTime() <= now.getTime());
  return allowed ? { ok: true, to } : { ok: false, from: booking.status, to };
}

/**
 * Whether `latest` (the booking's latest change) may be undone by a client that saw `changeId`:
 * the same change, ≤ 5 minutes old, not itself an undo and not the creation.
 */
export function undoable(
  latest: {
    id: string;
    fromStatus: ReservationStatus | null;
    undoesId: string | null;
    createdAt: Date;
  },
  changeId: string,
  now: Date,
): boolean {
  return (
    latest.id === changeId &&
    latest.undoesId === null &&
    latest.fromStatus !== null &&
    // An answer to an online booking (accept, confirm, decline) is told to the guest: no undo (R2.3b).
    latest.fromStatus !== 'requested' &&
    latest.fromStatus !== 'pending' &&
    now.getTime() - latest.createdAt.getTime() <= UNDO_WINDOW_MS
  );
}

/**
 * Whether a till order belongs to the party of a booking starting at `startsAt`: opened within
 * ±`windowMinutes` (setting `reservations.orderMatchWindowMinutes`). An older order is the previous
 * party's, a much later one a walk-in's (docs/modules/reservations.md → R1.7).
 */
export function isPartyOrder(openedAt: Date, startsAt: Date, windowMinutes: number): boolean {
  return Math.abs(openedAt.getTime() - startsAt.getTime()) <= windowMinutes * 60_000;
}
