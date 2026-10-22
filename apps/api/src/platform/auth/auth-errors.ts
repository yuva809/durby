import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../http';

/** Error codes of platform/auth (docs/platform/auth.md → Error codes). */
export const authErrors = {
  unauthenticated: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'auth.unauthenticated', 'Authentication required.'),
  invalidCredentials: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'auth.invalid_credentials', 'Invalid email or password.'),
  emailNotVerified: () =>
    new ApiError(HttpStatus.FORBIDDEN, 'auth.email_not_verified', 'Email address not verified.'),
  tooManyAttempts: (retryAfterSeconds: number) =>
    new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      'auth.too_many_attempts',
      'Too many failed attempts. Try again later.',
      undefined,
      { 'Retry-After': String(retryAfterSeconds) },
    ),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      'auth.rate_limited',
      'Too many requests. Try again later.',
      undefined,
      { 'Retry-After': String(retryAfterSeconds) },
    ),
  refreshInvalid: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'auth.refresh_invalid', 'Session expired.'),
  refreshReused: () =>
    new ApiError(
      HttpStatus.UNAUTHORIZED,
      'auth.refresh_reused',
      'Session revoked: refresh token was reused.',
    ),
  notAMember: () =>
    new ApiError(HttpStatus.FORBIDDEN, 'auth.not_a_member', 'Not a member of this organization.'),
  originRejected: () =>
    new ApiError(HttpStatus.FORBIDDEN, 'auth.origin_rejected', 'Request origin not allowed.'),
  tokenInvalid: () =>
    new ApiError(HttpStatus.BAD_REQUEST, 'auth.token_invalid', 'Link is invalid or has expired.'),
  unavailable: () =>
    new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'auth.unavailable',
      'Authentication is temporarily unavailable.',
    ),
} as const;
