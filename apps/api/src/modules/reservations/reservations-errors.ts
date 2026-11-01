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
  partyRangeInvalid: (details: { minParty: number; maxParty: number }) =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'reservations.party_range_invalid',
      'The minimum party size exceeds the maximum or the capacity.',
      details,
    ),
};
