import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../http';

/** Error codes of /api/v1/platform (docs/platform/admin-portal.md → Errors). */
export const staffErrors = {
  unauthenticated: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'staff.unauthenticated', 'Staff sign-in required.'),
  invalidCredentials: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'staff.invalid_credentials', 'Invalid credentials.'),
  reauthRequired: () =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'staff.reauth_required', 'Confirm your password first.'),
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
  customerDuplicate: (details: { nameTaken: boolean; ownerHasAccount: boolean }) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'staff.customer_duplicate',
      'A customer with this name or an account with this email already exists.',
      details,
    ),
  customerNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'staff.customer_not_found', 'Customer not found.'),
  ownerActive: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'staff.owner_active',
      'The owner has already set a password.',
    ),
  partnerNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'staff.partner_not_found', 'Partner not found.'),
};
