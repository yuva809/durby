import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { MAX_PARTY_SIZE } from '../reservation-settings';
import { isLocalDate } from '../time/zoned';

/**
 * The online booking page of a location (docs/modules/reservations.md → R2.1, ADR 0085): its address
 * `/b/{slug}` on the domain of the restaurant's partner, and the public routes behind it.
 */

export const BOOKING_SLUG_MIN = 3;
export const BOOKING_SLUG_MAX = 60;
/** Lower-case letters, digits, single hyphens inside. */
export const BOOKING_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Paths of the app or words a guest could take for Durby's own pages. */
export const RESERVED_BOOKING_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'book',
  'booking',
  'durby',
  'embed',
  'help',
  'login',
  'manage',
  'new',
  'public',
  'support',
  'widget',
];

export const bookingSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(BOOKING_SLUG_MIN)
  .max(BOOKING_SLUG_MAX)
  .regex(BOOKING_SLUG_PATTERN, { message: 'Letters, digits and single hyphens only' })
  .refine((slug) => !RESERVED_BOOKING_SLUGS.includes(slug), { message: 'Reserved' });

/** A suggestion from names: "Demo Bistro", "Main street" → "demo-bistro-main-street". */
export function suggestBookingSlug(...names: readonly string[]): string {
  const slug = names
    .join(' ')
    .normalize('NFKD')
    .replace(/ß/g, 'ss')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BOOKING_SLUG_MAX)
    .replace(/-+$/g, '');
  const safe = slug.length >= BOOKING_SLUG_MIN ? slug : `${slug}-booking`.replace(/^-/, '');
  return RESERVED_BOOKING_SLUGS.includes(safe) ? `${safe}-table` : safe;
}

/** The path of a page on its partner's domain. */
export const bookingPagePath = (slug: string) => `/b/${slug}`;

// --- Staff ---------------------------------------------------------------------------------------

export const bookingPageQuerySchema = z.strictObject({ locationId: z.uuid() });

export const bookingPageSchema = z.object({
  locationId: z.uuid(),
  slug: z.string(),
  enabled: z.boolean(),
  /** `/b/{slug}`: the web adds the origin it runs on (the staff's partner domain). */
  path: z.string(),
  /** The organization's plan has `reservations.online`; without it the page answers nobody. */
  online: z.boolean(),
});

export const bookingPageResponseSchema = z.object({
  page: bookingPageSchema.nullable(),
  /** For a location without a page: a slug to start from. */
  suggestedSlug: z.string(),
  online: z.boolean(),
});

export const putBookingPageRequestSchema = z.strictObject({
  locationId: z.uuid(),
  slug: bookingSlugSchema,
  enabled: z.boolean(),
});

// --- Public (no session) -------------------------------------------------------------------------

export const publicBookingPageSchema = z.object({
  /** The restaurant's name (organization), and the location's. */
  restaurant: z.string(),
  location: z.string(),
  timeZone: z.string(),
  locale: z.enum(LOCALES),
  currency: z.string(),
  /** Parties up to this size book at once; larger ones send a request (R2.3). Null: every size books at once. */
  instantMaxParty: z.int().nullable(),
  /** The last day guests may book online (`reservations.maxAdvanceDays`, R2.2), YYYY-MM-DD at the location. */
  lastBookableDate: z.string(),
});

export const publicAvailabilityQuerySchema = z.strictObject({
  date: z.string().refine(isLocalDate, { message: 'Expected a date YYYY-MM-DD' }),
  partySize: z.coerce.number().int().min(1).max(MAX_PARTY_SIZE),
});

export const publicSlotSchema = z.strictObject({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  /** `request`: the restaurant confirms (larger parties, R2.3). */
  status: z.enum(['available', 'request', 'full']),
});

export const publicAvailabilitySchema = z.strictObject({
  date: z.string(),
  closed: z.boolean(),
  turnMinutes: z.int(),
  slots: z.array(publicSlotSchema),
});

/**
 * Holds a slot while the guest fills in the form (R2.2, ADR 0019 §4). `website` is a honeypot: people never see it,
 * so a filled one is a bot (it gets a believable answer and nothing is held).
 */
export const createHoldRequestSchema = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }),
  partySize: z.int().min(1).max(MAX_PARTY_SIZE),
  /** The guest's previous hold on this page, freed in the same step. */
  replaceHoldId: z.uuid().optional(),
  website: z.string().max(200).optional(),
});

export const holdSchema = z.strictObject({
  holdId: z.uuid(),
  expiresAt: z.iso.datetime(),
});

export type CreateHoldRequest = z.infer<typeof createHoldRequestSchema>;
export type Hold = z.infer<typeof holdSchema>;
export type BookingPageQuery = z.infer<typeof bookingPageQuerySchema>;
export type BookingPage = z.infer<typeof bookingPageSchema>;
export type BookingPageResponse = z.infer<typeof bookingPageResponseSchema>;
export type PutBookingPageRequest = z.infer<typeof putBookingPageRequestSchema>;
export type PublicBookingPage = z.infer<typeof publicBookingPageSchema>;
export type PublicAvailabilityQuery = z.infer<typeof publicAvailabilityQuerySchema>;
export type PublicAvailability = z.infer<typeof publicAvailabilitySchema>;
