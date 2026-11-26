import {
  type CreateWaitlistEntryRequest,
  type ReservationsFloorTable,
  type SeatWaitlistEntryRequest,
  seatWaitlistEntryResponseSchema,
  type UpdateWaitlistEntryRequest,
  WAITLIST_MAX_EMAILS,
  WAITLIST_NOTICE_GAP_MS,
  type WaitlistChannel,
  type WaitlistEntry,
  waitlistEntrySchema,
  waitlistResponseSchema,
} from '@durby/shared';
import { type Api, read, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls and display rules of the waitlist (docs/modules/reservations.md → Waitlist). */

const PATH = '/api/v1/reservations/waitlist';

export const loadWaitlist = (store: Api, locationId: string) =>
  read(store, `${PATH}?${new URLSearchParams({ locationId })}`, waitlistResponseSchema);

export const addEntry = (store: Api, action: ActionKey, body: CreateWaitlistEntryRequest) =>
  write(store, action, PATH, 'POST', body, waitlistEntrySchema);

export const updateEntry = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateWaitlistEntryRequest,
) => write(store, action, `${PATH}/${id}`, 'PATCH', body, waitlistEntrySchema);

export const notifyEntry = (store: Api, action: ActionKey, id: string, channel: WaitlistChannel) =>
  write(store, action, `${PATH}/${id}/notify`, 'POST', { channel }, waitlistEntrySchema);

export const seatEntry = (
  store: Api,
  action: ActionKey,
  id: string,
  body: SeatWaitlistEntryRequest,
) => write(store, action, `${PATH}/${id}/seat`, 'POST', body, seatWaitlistEntryResponseSchema);

export const moveEntry = (store: Api, action: ActionKey, id: string, what: 'leave' | 'return') =>
  write(store, action, `${PATH}/${id}/${what}`, 'POST', {}, waitlistEntrySchema);

export const removeEntry = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `${PATH}/${id}`, 'DELETE', undefined, waitlistEntrySchema);

const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));

export const waitedMinutes = (entry: WaitlistEntry, now: number) =>
  minutesSince(entry.createdAt, now);

/** The party waits longer than it was told. */
export const overQuoted = (entry: WaitlistEntry, now: number) =>
  entry.status === 'waiting' &&
  entry.quotedMinutes !== null &&
  waitedMinutes(entry, now) > entry.quotedMinutes;

/** The party was told, and the time to come is over. */
export const overHold = (entry: WaitlistEntry, now: number, holdMinutes: number) =>
  entry.status === 'notified' &&
  entry.notifiedAt !== null &&
  entry.noticeResult !== 'failed' &&
  minutesSince(entry.notifiedAt, now) >= holdMinutes;

/** Whether an email can go out now (the api checks again). */
export function canEmail(entry: WaitlistEntry, now: number): boolean {
  if (entry.email === null || entry.emailCount >= WAITLIST_MAX_EMAILS) return false;
  return !(
    entry.noticeChannel === 'email' &&
    entry.noticeResult !== 'failed' &&
    entry.notifiedAt !== null &&
    now - Date.parse(entry.notifiedAt) < WAITLIST_NOTICE_GAP_MS
  );
}

export const callLink = (phone: string) => `tel:${phone}`;
/** Opens the host's own phone app with the text ready; Durby sends nothing. */
export const messageLink = (phone: string, text: string) =>
  `sms:${phone}?body=${encodeURIComponent(text)}`;

/** The smallest free table the party fits at, to start the dialog with. */
export function suggestTable(
  tables: readonly ReservationsFloorTable[],
  partySize: number,
): string[] {
  const fits = tables
    .filter((t) => t.state === 'free' && t.seats >= partySize)
    .sort((a, b) => a.seats - b.seats || a.sortOrder - b.sortOrder);
  return fits.length > 0 ? [fits[0]!.id] : [];
}
