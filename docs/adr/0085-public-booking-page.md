# ADR 0085: Public booking page, tenant from the slug and the domain

- Status: accepted
- Date: 2026-11-26
- Spec: [reservations](../modules/reservations.md) → Q1, R2.1. Amends hard rule 1 (CLAUDE.md) as
  [ADR 0026](0026-qr-menu-and-kitchen-display.md) did for the QR menu; adds a definer function under [ADR 0006](0006-authentication.md) (allow-listed definer functions).

## Context

Guests book a table online without an account. A public request carries no session, so the organization can't come
from one. Hard rule 1 says the tenant never comes from the request. Durby runs several partners' brands on their own
domains: a restaurant must never appear under another partner's brand, and AsiaMight (a distributor) takes no table
bookings at all.

## Decisions

1. **A location has at most one booking page**, `reservation_booking_pages`: a normal tenant table (RLS forced) with a
   `slug` unique across every tenant and `enabled`. Staff set it under Settings → Reservations
   (`PUT /reservations/booking-page`, `reservations.setup.edit`), audited.
2. **The slug is the only thing a public request names.** `booking_page_by_slug(slug)` is the single cross-tenant
   read: an allow-listed `SECURITY DEFINER` function owned by `durby_rls_definer`, which may read only the slug,
   organization, location and on/off columns. The api then works inside that organization's tenant context with an
   anonymous user id. No public route accepts an organization or location id.
3. **The domain must belong to the restaurant's partner.** A `partner_domains` host names its partner; any other host
   is the default partner (Durby). The page answers only when they match, so Durby restaurants are bookable on
   Durby's domain, a partner's restaurants on that partner's domain, and nothing on another brand's domain.
4. **One answer for every refusal**: an unknown or malformed slug, a page switched off, an archived location, an
   organization without `reservations.online`, or the wrong domain all give `404 reservations.booking_page_not_found`.
5. **Rate limits** per client address and per page (Redis counters, `429` with `Retry-After`). Writes (R2.3) add a
   honeypot field and the `guest` audit actor; reads need neither.
6. **The public answer carries no ids**: names, time zone, locale, currency, the instant-booking party limit, and
   for availability only start, end and status of each slot (the engine's online channel: staff-only tables and
   non-online combinations never show).

## Consequences

- Deviation from the spec sketch (a platform table outside RLS): writes stay under tenant RLS; the price is one more
  allow-listed definer function and its column grants (covered by the definer tests).
- Slugs are first come, first served across all organizations; a taken one is a `409`.
- A slug change breaks old links at once (no redirect in this version).
- Next: R2.2 holds, R2.3 booking and the manage link, R2.6 the guest page at `/b/{slug}`.
