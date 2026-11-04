import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { newPasswordSchema } from './auth';
import { roleRefSchema } from './rbac';

/** Request and response bodies of /api/v1/invitations (docs/platform/rbac.md → Invitations). */

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
/**
 * `<organization id>.<secret>`. Only bounded here: a malformed token gets the same
 * 400 auth.token_invalid as an unknown or expired one, from the api.
 */
const invitationToken = z.string().min(1).max(200);

export const INVITATION_TTL_DAYS = 7;

export const createInvitationRequestSchema = z.object({
  email,
  roleId: z.uuid(),
  /** null or absent = all locations. */
  locationIds: z.array(z.uuid()).max(500).nullable().optional(),
  /** The new staff member's language: the mail (unless they have an account) and their account. */
  locale: z.enum(LOCALES).optional(),
});

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: roleRefSchema,
  allLocations: z.boolean(),
  locationIds: z.array(z.uuid()),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const invitationListResponseSchema = z.object({ data: z.array(invitationSchema) });

export const invitationTokenRequestSchema = z.object({ token: invitationToken });

export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  email: z.string(),
  role: roleRefSchema,
  /** Only the token holder learns this; the inviter never does (ADR 0007). */
  accountExists: z.boolean(),
  expiresAt: z.iso.datetime(),
});

export const acceptInvitationRequestSchema = z.object({
  token: invitationToken,
  password: newPasswordSchema,
  /** UI locale of the new user, unless the inviter chose one; unknown values fall back to `en`. */
  locale: z.string().max(10).optional(),
});

export const acceptInvitationResponseSchema = z.object({ organizationId: z.uuid() });

export const INVITATION_ERROR_CODES = [
  'invitations.already_member',
  'invitations.sign_in_required',
  'invitations.email_mismatch',
] as const;

export type InvitationErrorCode = (typeof INVITATION_ERROR_CODES)[number];
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type InvitationListResponse = z.infer<typeof invitationListResponseSchema>;
export type InvitationTokenRequest = z.infer<typeof invitationTokenRequestSchema>;
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;
