import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../http';

/** Error codes of /api/v1/platform (docs/platform/admin-portal.md → Errors). */
export const staffErrors = {
  unauthenticated: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'staff.unauthenticated', 'Staff sign-in required.'),
  invalidCredentials: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'staff.invalid_credentials', 'Invalid credentials.'),
  invalidCode: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'staff.invalid_code', 'Invalid or used code.'),
  reauthRequired: () =>
    new ApiError(
      HttpStatus.UNAUTHORIZED,
      'staff.reauth_required',
      'Confirm your password and a code first.',
    ),
  permissionDenied: (permission: string) =>
    new ApiError(HttpStatus.FORBIDDEN, 'staff.permission_denied', 'Permission denied.', {
      permission,
    }),
  invitationInvalid: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'staff.invitation_invalid',
      'Invalid or expired invitation.',
    ),
  emailDomain: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'staff.email_domain',
      'Only company email addresses can be invited.',
    ),
  notFound: () => new ApiError(HttpStatus.NOT_FOUND, 'staff.not_found', 'Staff member not found.'),
  alreadyActive: () =>
    new ApiError(HttpStatus.CONFLICT, 'staff.already_active', 'The account is already active.'),
  lastSuperAdmins: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'staff.last_super_admins',
      'At least 2 active super admins must remain.',
    ),
  cannotChangeSelf: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'staff.cannot_change_self',
      'Another super admin must change your account.',
    ),
  enrollNotAllowed: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'staff.enroll_not_allowed',
      'Two-factor authentication is already set up.',
    ),
};
