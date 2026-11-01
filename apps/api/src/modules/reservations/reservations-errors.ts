import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../platform/http';

/** Error codes of the reservations module (docs/modules/reservations.md → Errors). */
export const reservationErrors = {
  locationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'reservations.location_not_found', 'Location not found.'),
};
