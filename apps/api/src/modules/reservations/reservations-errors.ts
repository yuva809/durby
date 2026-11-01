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
  invalidTransition: (details: { from: string; to?: string }) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'reservations.invalid_transition',
      'Not possible in the current status.',
      details,
    ),
  partyRangeInvalid: (details: { minParty: number; maxParty: number }) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'reservations.party_range_invalid',
      'The minimum party size exceeds the maximum or the capacity.',
      details,
    ),
};
