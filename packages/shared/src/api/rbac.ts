import { z } from 'zod';
import { SYSTEM_ROLES } from '../permissions';

/** Request and response bodies of /api/v1/roles and /api/v1/members (docs/platform/rbac.md). */

export const ROLE_NAME_MAX_LENGTH = 100;

const roleName = z.string().trim().min(1).max(ROLE_NAME_MAX_LENGTH);
/** Checked against the permission registry by the api (400 rbac.permission_unknown). */
const permissionKeys = z.array(z.string().min(1).max(100)).max(500);
/** null = all locations; an array limits the membership to those locations. */
const locationScope = z.array(z.uuid()).max(500).nullable();

export const roleRefSchema = z.object({
  id: z.uuid(),
  systemKey: z.enum(SYSTEM_ROLES).nullable(),
  /** Custom roles only; system roles show the label `platform.roles.<systemKey>`. */
  name: z.string().nullable(),
});

export const roleSchema = roleRefSchema.extend({
  /** Effective keys: the registry-defined set for system roles, the stored keys for custom ones. */
  permissions: z.array(z.string()),
});

export const createRoleRequestSchema = z.object({ name: roleName, permissions: permissionKeys });

export const updateRoleRequestSchema = z
  .object({ name: roleName.optional(), permissions: permissionKeys.optional() })
  .refine((body) => body.name !== undefined || body.permissions !== undefined, {
    message: 'Nothing to update',
  });

export const memberSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  /** null for a membership created before roles existed (no permissions). */
  role: roleRefSchema.nullable(),
  allLocations: z.boolean(),
  locationIds: z.array(z.uuid()),
});

export const updateMemberRequestSchema = z
  .object({ roleId: z.uuid().optional(), locationIds: locationScope.optional() })
  .refine((body) => body.roleId !== undefined || body.locationIds !== undefined, {
    message: 'Nothing to update',
  });

export const roleListResponseSchema = z.object({ data: z.array(roleSchema) });
export const memberListResponseSchema = z.object({ data: z.array(memberSchema) });

/** Stable error codes of the rbac endpoints; the web app shows the matching label. */
export const RBAC_ERROR_CODES = [
  'rbac.permission_denied',
  'rbac.platform_only',
  'rbac.route_unmarked',
  'rbac.not_grantable',
  'rbac.cannot_change_self',
  'rbac.last_owner',
  'rbac.owner_all_locations',
  'rbac.role_not_found',
  'rbac.member_not_found',
  'rbac.location_not_found',
  'rbac.invitation_not_found',
  'rbac.permission_unknown',
  'rbac.system_role_immutable',
  'rbac.role_in_use',
  'rbac.role_name_taken',
] as const;

export type RbacErrorCode = (typeof RBAC_ERROR_CODES)[number];
export type RoleRef = z.infer<typeof roleRefSchema>;
export type Role = z.infer<typeof roleSchema>;
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;
export type Member = z.infer<typeof memberSchema>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
export type RoleListResponse = z.infer<typeof roleListResponseSchema>;
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;
