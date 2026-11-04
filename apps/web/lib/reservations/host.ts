import {
  addDays,
  type CreateReservationRequest,
  type CreateWalkInRequest,
  type LocalDate,
  MIN_WALK_IN_MINUTES,
  RESERVATION_UNDO_WINDOW_MS,
  type Reservation,
  reservationSchema,
  type ReservationsFloorResponse,
  reservationsFloorResponseSchema,
  type ReservationsFloorTable,
  reservationsListResponseSchema,
  type UpdateReservationRequest,
  zonedInstant,
  zonedParts,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/**
 * Calls and display rules of the host screen (docs/modules/reservations.md → Web, R1.8b). Pure
 * helpers take `now` and the location's time zone, so they are tested without a clock.
 */

/** Today: now, live. Another day: a moment of it (default its first service window), a plan. */
export type FloorMoment =
  { kind: 'now' } | { kind: 'date'; date: LocalDate } | { kind: 'at'; at: string };

export function loadFloor(
  store: Api,
  locationId: string,
  moment: FloorMoment,
): Promise<Result<ReservationsFloorResponse>> {
  const query = new URLSearchParams({ locationId });
  if (moment.kind === 'date') query.set('date', moment.date);
  if (moment.kind === 'at') query.set('at', moment.at);
  return read(store, `/api/v1/reservations/floor?${query}`, reservationsFloorResponseSchema);
}

export const loadDay = (
  store: Api,
  locationId: string,
  date: LocalDate,
): Promise<Result<Reservation[]>> =>
  read(
    store,
    `/api/v1/reservations?${new URLSearchParams({ locationId, date })}`,
    list(reservationsListResponseSchema),
  );

export const createBooking = (store: Api, action: ActionKey, body: CreateReservationRequest) =>
  write(store, action, '/api/v1/reservations', 'POST', body, reservationSchema);

export const createWalkIn = (store: Api, action: ActionKey, body: CreateWalkInRequest) =>
  write(store, action, '/api/v1/reservations/walk-ins', 'POST', body, reservationSchema);

export const updateBooking = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateReservationRequest,
) => write(store, action, `/api/v1/reservations/${id}`, 'PATCH', body, reservationSchema);

export type HostAction = 'arrive' | 'seat' | 'finish' | 'no-show' | 'cancel';

export const runAction = (
  store: Api,
  action: ActionKey,
  id: string,
  what: HostAction,
  body: { tableIds?: string[] } = {},
) => write(store, action, `/api/v1/reservations/${id}/${what}`, 'POST', body, reservationSchema);

export const undoChange = (store: Api, action: ActionKey, id: string, changeId: string) =>
  write(store, action, `/api/v1/reservations/${id}/undo`, 'POST', { changeId }, reservationSchema);

// --- Display rules --------------------------------------------------------------------------------

/** The status actions a booking offers (Status flow): no-show only once its start has passed. */
export function actionsFor(booking: Reservation, now: number): HostAction[] {
  const started = Date.parse(booking.startsAt) <= now;
  switch (booking.status) {
    case 'booked':
      return ['arrive', 'seat', ...(started ? (['no-show'] as const) : []), 'cancel'];
    case 'arrived':
      return ['seat', ...(started ? (['no-show'] as const) : []), 'cancel'];
    case 'pending':
      return ['cancel'];
    case 'seated':
      return ['finish'];
    default:
      return [];
  }
}

/** The latest change can be undone: within the window, not itself an undo, not the creation. */
export function undoable(booking: Reservation, now: number): boolean {
  const change = booking.lastChange;
  return (
    change.fromStatus !== null &&
    change.undoesId === null &&
    now - Date.parse(change.createdAt) <= RESERVATION_UNDO_WINDOW_MS
  );
}

/** Whole minutes left to undo (at least 1 while undoable). */
export function undoMinutesLeft(booking: Reservation, now: number): number {
  const left = RESERVATION_UNDO_WINDOW_MS - (now - Date.parse(booking.lastChange.createdAt));
  // The change's time is the database's clock: a browser a little behind it must not show 6 of 5.
  return Math.min(RESERVATION_UNDO_WINDOW_MS / 60_000, Math.max(1, Math.ceil(left / 60_000)));
}

/** The till's badge, if the system seated or finished the booking from a pos order (R1.7). */
export function tillBadge(booking: Reservation): 'autoSeated' | 'finishedAtTill' | null {
  const change = booking.lastChange;
  if (change.actorKind !== 'system' || change.sourceOrderId === null) return null;
  if (change.toStatus === 'seated' && booking.status === 'seated') return 'autoSeated';
  if (change.toStatus === 'finished' && booking.status === 'finished') return 'finishedAtTill';
  return null;
}

const BLOCKING = new Set(['pending', 'booked', 'arrived', 'seated']);

/** The day's counts in the header: covers of blocking bookings, booked (not yet here), seated. */
export function dayCounts(bookings: readonly Reservation[]) {
  const blocking = bookings.filter((b) => BLOCKING.has(b.status));
  return {
    covers: blocking.reduce((sum, b) => sum + b.partySize, 0),
    booked: bookings.filter((b) => b.status === 'booked' || b.status === 'pending').length,
    seated: bookings.filter((b) => b.status === 'seated').length,
  };
}

/** Bookings the floor says are due on a table that something else still occupies. */
export function stillOccupied(tables: readonly ReservationsFloorTable[]): Set<string> {
  return new Set(tables.flatMap((t) => (t.next?.tableStillOccupied ? [t.next.reservationId] : [])));
}

/**
 * For a walk-in that runs into the chosen tables' next booking: the earliest such start, if it is at
 * least MIN_WALK_IN_MINUTES away (the api's shortest walk-in); else null.
 */
export function seatUntil(
  tableIds: readonly string[],
  tables: readonly ReservationsFloorTable[],
  now: number,
): string | null {
  const starts = tables
    .filter((t) => tableIds.includes(t.id) && t.next)
    .map((t) => Date.parse(t.next!.startsAt))
    .filter((start) => start > now);
  if (starts.length === 0) return null;
  const until = Math.min(...starts);
  return until - now >= MIN_WALK_IN_MINUTES * 60_000 ? new Date(until).toISOString() : null;
}

// --- Time ------------------------------------------------------------------------------------------

/** HH:mm of an instant at the location. */
export function clockTime(iso: string, timeZone: string): string {
  const { hour, minute } = zonedParts(new Date(iso), timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The location's local date of an instant. */
export const localDate = (at: number, timeZone: string): LocalDate =>
  zonedParts(new Date(at), timeZone).date;

export const shiftDate = (date: LocalDate, days: number): LocalDate => addDays(date, days);

/** A local date and HH:mm at the location as an ISO instant; null for a time DST skips. */
export function instantAt(date: LocalDate, time: string, timeZone: string): string | null {
  return zonedInstant(date, time, timeZone)?.toISOString() ?? null;
}

const STEP_MS = 15 * 60_000;

/** The time selector of another day: every 15 minutes through its service windows. */
export function timeOptions(
  windows: readonly { start: string; end: string }[],
  timeZone: string,
): { at: string; label: string }[] {
  const seen = new Set<number>();
  const options: { at: string; label: string }[] = [];
  for (const w of windows) {
    for (let t = Date.parse(w.start); t < Date.parse(w.end); t += STEP_MS) {
      if (seen.has(t)) continue;
      seen.add(t);
      const at = new Date(t).toISOString();
      options.push({ at, label: clockTime(at, timeZone) });
    }
  }
  return options.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
