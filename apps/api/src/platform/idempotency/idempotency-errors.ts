import { HttpStatus } from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER } from '@durby/shared';
import { ApiError } from '../http';

/** Error codes of platform/idempotency (docs/platform/idempotency.md → Behaviour). */
export const idempotencyErrors = {
  keyRequired: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'idempotency.key_required',
      `This request needs an ${IDEMPOTENCY_KEY_HEADER} header.`,
    ),
  keyInvalid: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'idempotency.key_invalid',
      `${IDEMPOTENCY_KEY_HEADER} must be 1–255 visible ASCII characters.`,
    ),
  keyReused: () =>
    new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'idempotency.key_reused',
      `This ${IDEMPOTENCY_KEY_HEADER} was used for a different request.`,
    ),
  requestInProgress: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'idempotency.request_in_progress',
      `A request with this ${IDEMPOTENCY_KEY_HEADER} is still running.`,
    ),
};
