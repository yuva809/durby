import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { MAX_PARTY_SIZE } from '../reservation-settings';
import { guestEmail, reservationSchema, tableIdList } from './reservations';

/** Bodies of the waitlist routes (docs/modules/reservations.md → Waitlist, ADR 0084). */

export const WAITLIST_STATUSES = ['waiting', 'notified', 'seated', 'left', 'removed'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];
/** Still on the list. */
export const OPEN_WAITLIST_STATUSES = ['waiting', 'notified'] as const;

/** How a guest is told; SMS joins when there is a provider. */
export const WAITLIST_CHANNELS = ['email', 'in_person'] as const;
export type WaitlistChannel = (typeof WAITLIST_CHANNELS)[number];
export const WAITLIST_NOTICE_RESULTS = ['pending', 'sent', 'failed'] as const;
export type WaitlistNoticeResult = (typeof WAITLIST_NOTICE_RESULTS)[number];

export const WAITLIST_MAX_EMAILS = 3;
/** Between two emails to the same address; a failed one can be sent again at once. */
export const WAITLIST_NOTICE_GAP_MS = 60_000;
/** How long an ended entry keeps its contact data, and how long an open one stays on the list. */
export const WAITLIST_KEEP_HOURS = 24;

export const WAITLIST_NAME_MAX = 100;
export const WAITLIST_NOTE_MAX = 200;
export const WAITLIST_MAX_QUOTED_MINUTES = 600;

/** One line: the name goes into an email. */
const name = z
  .string()
  .trim()
  .min(1)
  .max(WAITLIST_NAME_MAX)
  .regex(/^[^\p{Cc}]*$/u);
const partySize = z.int().min(1).max(MAX_PARTY_SIZE);
const phone = z.string().trim().min(1).max(40);
const quotedMinutes = z.int().min(0).max(WAITLIST_MAX_QUOTED_MINUTES);
const note = z.string().trim().min(1).max(WAITLIST_NOTE_MAX);
const locale = z.enum(LOCALES);

export const waitlistEntrySchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  /** Null once erased, like phone, email and note. */
  name: z.string().nullable(),
  /** E.164. */
  phone: z.string().nullable(),
  email: z.string().nullable(),
  locale,
  partySize: z.int(),
  quotedMinutes: z.int().nullable(),
  note: z.string().nullable(),
  status: z.enum(WAITLIST_STATUSES),
  createdAt: z.iso.datetime(),
  /** The latest time the guest was told. */
  notifiedAt: z.iso.datetime().nullable(),
  noticeChannel: z.enum(WAITLIST_CHANNELS).nullable(),
  noticeResult: z.enum(WAITLIST_NOTICE_RESULTS).nullable(),
  /** Emails sent so far, at most `WAITLIST_MAX_EMAILS`. */
  emailCount: z.int(),
  endedAt: z.iso.datetime().nullable(),
  /** The booking the party was seated as. */
  reservationId: z.uuid().nullable(),
});

export const waitlistQuerySchema = z.strictObject({ locationId: z.uuid() });

export const waitlistResponseSchema = z.object({
  /** `reservations.waitlistHoldMinutes` at the location. */
  holdMinutes: z.int(),
  /** "Your table is ready" per language, for a message from the host's own phone. */
  readyText: z.record(locale, z.string()),
  /** On the list, in the order of adding. */
  open: z.array(waitlistEntrySchema),
  /** Ended today (the location's date), latest first. */
  ended: z.array(waitlistEntrySchema),
});

export const createWaitlistEntryRequestSchema = z.strictObject({
  locationId: z.uuid(),
  name,
  partySize,
  phone: phone.optional(),
  email: guestEmail.optional(),
  /** Default: the location's language. */
  locale: locale.optional(),
  quotedMinutes: quotedMinutes.optional(),
  note: note.optional(),
});

export const updateWaitlistEntryRequestSchema = z
  .strictObject({
    name: name.optional(),
    partySize: partySize.optional(),
    phone: phone.nullable().optional(),
    email: guestEmail.nullable().optional(),
    locale: locale.optional(),
    quotedMinutes: quotedMinutes.nullable().optional(),
    note: note.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

export const notifyWaitlistEntryRequestSchema = z.strictObject({
  channel: z.enum(WAITLIST_CHANNELS),
});

export const seatWaitlistEntryRequestSchema = z.strictObject({
  tableIds: tableIdList,
  /** Default: the entry's. */
  partySize: partySize.optional(),
  /** As for a walk-in: until the table's next booking. */
  endsAt: z.iso.datetime({ offset: true }).optional(),
});

export const seatWaitlistEntryResponseSchema = z.object({
  entry: waitlistEntrySchema,
  reservation: reservationSchema,
});

export type WaitlistEntry = z.infer<typeof waitlistEntrySchema>;
export type WaitlistQuery = z.infer<typeof waitlistQuerySchema>;
export type WaitlistResponse = z.infer<typeof waitlistResponseSchema>;
export type CreateWaitlistEntryRequest = z.infer<typeof createWaitlistEntryRequestSchema>;
export type UpdateWaitlistEntryRequest = z.infer<typeof updateWaitlistEntryRequestSchema>;
export type NotifyWaitlistEntryRequest = z.infer<typeof notifyWaitlistEntryRequestSchema>;
export type SeatWaitlistEntryRequest = z.infer<typeof seatWaitlistEntryRequestSchema>;
export type SeatWaitlistEntryResponse = z.infer<typeof seatWaitlistEntryResponseSchema>;
