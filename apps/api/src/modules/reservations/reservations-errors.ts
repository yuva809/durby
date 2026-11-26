import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../platform/http';

/** Error codes of the reservations module (docs/modules/reservations.md → Errors). */
export const reservationErrors = {
  locationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'reservations.location_not_found', 'Location not found.'),
  tableNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'reservations.table_not_found', 'Table not found.'),
  combinationNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'reservations.combination_not_found',
      'Table combination not found.',
    ),
  guestNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'reservations.guest_not_found', 'Guest not found.'),
  reservationNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'reservations.reservation_not_found',
      'Reservation not found.',
    ),
  tableWalkInOnly: () =>
    new ApiError(HttpStatus.CONFLICT, 'reservations.table_walk_in_only', 'Walk-ins only.'),
  partySizeOutOfRange: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.party_size_out_of_range',
      'The tables do not take this party size.',
    ),
  tableOccupied: () =>
    new ApiError(HttpStatus.CONFLICT, 'reservations.table_occupied', 'The table is occupied.'),
  tableUnavailable: (details?: { nextStartsAt: string }) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.table_unavailable',
      'The table is booked at that time.',
      details,
    ),
  pacingExceeded: () =>
    new ApiError(HttpStatus.CONFLICT, 'reservations.pacing_exceeded', 'Covers per slot reached.'),
  outsideServiceHours: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.outside_service_hours',
      'Outside the reservation hours.',
    ),
  startsInPast: () =>
    new ApiError(HttpStatus.CONFLICT, 'reservations.starts_in_past', 'The start has passed.'),
  phoneInvalid: (field: string) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'reservations.phone_invalid',
      'Not a valid phone number.',
      { field },
    ),
  /** The booking's own table was archived (pos): it must move (docs → R1.8 note). */
  tableNotInService: (tableIds: string[]) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.table_not_in_service',
      'A table of the booking is no longer in service.',
      { tableIds },
    ),
  /** Overload (pool, transaction or lock timeout): retry the same request (same key) shortly. */
  busy: () =>
    new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'reservations.busy',
      'Busy, please retry.',
      undefined,
      { 'Retry-After': '2' },
    ),
  undoExpired: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.undo_expired',
      'Only the latest change can be undone, within 5 minutes.',
    ),
  invalidTransition: (details: { from: string; to?: string }) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.invalid_transition',
      'Not possible in the current status.',
      details,
    ),
  waitlistEntryNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'reservations.waitlist_entry_not_found',
      'Waitlist entry not found.',
    ),
  waitlistClosed: (details: { status: string }) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.waitlist_closed',
      'The party is no longer on the waitlist.',
      details,
    ),
  waitlistNoEmail: () =>
    new ApiError(HttpStatus.CONFLICT, 'reservations.waitlist_no_email', 'No email address.'),
  waitlistNoticeLimit: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.waitlist_notice_limit',
      'No more emails to this party.',
    ),
  waitlistNoticeTooSoon: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.waitlist_notice_too_soon',
      'The last email was sent less than a minute ago.',
    ),
  waitlistReturnExpired: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.waitlist_return_expired',
      'Only a party that left today can return.',
    ),
  /** Unknown, off, another partner's domain or without `reservations.online`: all alike (ADR 0085). */
  bookingPageNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'reservations.booking_page_not_found',
      'Booking page not found.',
    ),
  bookingSlugTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.booking_slug_taken',
      'This address is already taken.',
    ),
  /** The hold expired, is unknown or belongs to another page (R2.2; used by booking in R2.3). */
  holdNotFound: () =>
    new ApiError(HttpStatus.CONFLICT, 'reservations.hold_not_found', 'The hold has expired.'),
  /** Redis is down: online booking pauses, staff booking is unaffected (ADR 0019 §5). */
  holdsUnavailable: () =>
    new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'reservations.holds_unavailable',
      'Online booking is paused, please retry.',
      undefined,
      { 'Retry-After': '10' },
    ),
  partyRangeInvalid: (details: { minParty: number; maxParty: number }) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'reservations.party_range_invalid',
      'The minimum party size exceeds the maximum or the capacity.',
      details,
    ),
};
