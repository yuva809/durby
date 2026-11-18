import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { newPasswordSchema } from './auth';
import { roleRefSchema } from './rbac';

/**
 * Manage Staff: request and response bodies of /api/v1/staff (docs/platform/rbac.md → Manage Staff,
 * ADR 0023). Named "team" in code: `staff*` schemas are Durby's own platform staff (ADR 0017).
 */

export const TEAM_NAME_MAX_LENGTH = 100;
export const TEAM_PHONE_MAX_LENGTH = 40;

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const name = z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH);
const phone = z.string().trim().min(1).max(TEAM_PHONE_MAX_LENGTH);
/** Checked against the permission registry by the api (400 rbac.permission_unknown). */
const keys = z.array(z.string().min(1).max(100)).max(500);
/** null = all locations; an array limits the membership to those locations. */
const locationScope = z.array(z.uuid()).max(500).nullable();

/** A key may be in grants or in denies, not both. */
const disjoint = (body: { grants?: string[]; denies?: string[] }) =>
  !(body.grants ?? []).some((key) => (body.denies ?? []).includes(key));
const DISJOINT = { message: 'A permission is both granted and denied', path: ['denies'] };

export const createTeamMemberRequestSchema = z
  .object({
    name,
    email,
    phone: phone.optional(),
    roleId: z.uuid(),
    locationIds: locationScope.optional(),
    grants: keys.default([]),
    denies: keys.default([]),
    /** Set: create the account at once (when the email has none); empty: an invitation link. */
    temporaryPassword: newPasswordSchema.optional(),
    /** Also email the invitation link (when an invitation is created). */
    sendEmail: z.boolean().default(false),
    /** The new staff member's language; absent: the organization's `locale` setting. */
    locale: z.enum(LOCALES).optional(),
  })
  .refine(disjoint, DISJOINT);

export const createTeamMemberResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), membershipId: z.uuid() }),
  z.object({
    kind: z.literal('invited'),
    /** Its link comes from POST /invitations/:id/link, so no token is stored with this reply. */
    invitationId: z.uuid(),
    /** The email already has an account: they join with their own password. */
    existingAccount: z.boolean(),
  }),
]);

export const updateTeamMemberRequestSchema = z
  .object({
    name: name.nullable().optional(),
    phone: phone.nullable().optional(),
    roleId: z.uuid().optional(),
    locationIds: locationScope.optional(),
    grants: keys.optional(),
    denies: keys.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  })
  .refine(disjoint, DISJOINT);

export const teamMemberSchema = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  role: roleRefSchema.nullable(),
  allLocations: z.boolean(),
  locationIds: z.array(z.uuid()),
  grants: z.array(z.string()),
  denies: z.array(z.string()),
  /** Registered keys the member holds (role ± overrides, before location scope). */
  permissions: z.array(z.string()),
  status: z.enum(['active', 'inactive']),
  /** The newest session started in this organization, or null if they never signed in here. */
  lastActiveAt: z.iso.datetime().nullable(),
  joinedAt: z.iso.datetime(),
  /** Still has to replace the temporary password. */
  passwordChangePending: z.boolean(),
  /**
   * An owner or admin may set this member's password (ADR 0052): the account was created by this organization and
   * belongs to no other one.
   */
  passwordSettable: z.boolean(),
});

/**
 * POST /team/:id/password (ADR 0052). With `team.adminsManageSignIn` on, the password is final; off, it is
 * temporary and the member chooses their own at the next sign-in. Every session of the member ends.
 */
export const setMemberPasswordRequestSchema = z.object({ password: newPasswordSchema });

export const teamInvitationSchema = z.object({
  invitationId: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  role: roleRefSchema,
  allLocations: z.boolean(),
  locationIds: z.array(z.uuid()),
  grants: z.array(z.string()),
  denies: z.array(z.string()),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const teamListResponseSchema = z.object({
  members: z.array(teamMemberSchema),
  invitations: z.array(teamInvitationSchema),
  stats: z.object({
    total: z.int(),
    active: z.int(),
    inactive: z.int(),
    invited: z.int(),
    /** Members with at least one grant or deny. */
    customPermissions: z.int(),
  }),
});

export const invitationLinkResponseSchema = z.object({ link: z.url() });

export type CreateTeamMemberRequest = z.infer<typeof createTeamMemberRequestSchema>;
export type CreateTeamMemberResponse = z.infer<typeof createTeamMemberResponseSchema>;
export type UpdateTeamMemberRequest = z.infer<typeof updateTeamMemberRequestSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type SetMemberPasswordRequest = z.infer<typeof setMemberPasswordRequestSchema>;
export type TeamInvitation = z.infer<typeof teamInvitationSchema>;
export type TeamListResponse = z.infer<typeof teamListResponseSchema>;
export type InvitationLinkResponse = z.infer<typeof invitationLinkResponseSchema>;
