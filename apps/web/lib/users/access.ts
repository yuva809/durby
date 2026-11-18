import {
  canEditRole,
  canGrantRole,
  canManageMember,
  type GrantingActor,
  type Invitation,
  type Member,
  PERMISSION_KEYS,
  PERMISSIONS,
  type PermissionKey,
  type Role,
  type RoleView,
} from '@durby/shared';
import { isLabelKey, type LabelKey } from '@durby/i18n';
import type { Session } from '../auth/session';

/**
 * What the signed-in user may do on the members, invitations and roles pages
 * (docs/platform/web-shell.md → Users, roles, invitations). Built on the session's hints and the
 * shared granting rules (ADR 0015 §13): it hides what the api would refuse, it never grants.
 */

export interface UsersAccess {
  actor: GrantingActor;
  canReadUsers: boolean;
  canInvite: boolean;
  /** `platform.users.edit`: change a member's role, locations and permissions (ADR 0051). */
  canEditUsers: boolean;
  /** `platform.users.delete`: remove, deactivate and reactivate members. */
  canRemoveUsers: boolean;
  canReadRoles: boolean;
  canCreateRoles: boolean;
  canEditRoles: boolean;
  canDeleteRoles: boolean;
}

export function usersAccessOf(session: Session): UsersAccess {
  const permissions = new Set(session.activePermissions);
  return {
    actor: {
      userId: session.user.id,
      systemRole: session.activeRole?.systemKey ?? null,
      permissions,
    },
    canReadUsers: permissions.has('platform.users.read'),
    canInvite: permissions.has('platform.users.invite'),
    canEditUsers: permissions.has('platform.users.edit'),
    canRemoveUsers: permissions.has('platform.users.delete'),
    canReadRoles: permissions.has('platform.roles.read'),
    canCreateRoles: permissions.has('platform.roles.create'),
    canEditRoles: permissions.has('platform.roles.edit'),
    canDeleteRoles: permissions.has('platform.roles.delete'),
  };
}

export const roleViewOf = (role: Pick<Role, 'systemKey' | 'permissions'>): RoleView => ({
  systemKey: role.systemKey,
  keys: new Set(role.permissions),
});

/** Roles the actor may invite with or assign: Owner only for Owners, others by the subset rule. */
export function grantableRoles(access: UsersAccess, roles: readonly Role[]): Role[] {
  return roles.filter((role) => canGrantRole(access.actor, roleViewOf(role)));
}

export interface MemberActions {
  /** "You": no actions on your own membership. */
  self: boolean;
  canChange: boolean;
  canRemove: boolean;
}

/**
 * The actions to show on a member's row: change with `platform.users.edit`, remove with `platform.users.delete`,
 * both only for a member within your keys. Needs the role list (to know the member's current keys); without it,
 * nothing is offered.
 */
export function memberActions(
  access: UsersAccess,
  member: Member,
  roles: readonly Role[] | null,
): MemberActions {
  const self = member.userId === access.actor.userId;
  if (self || !(access.canEditUsers || access.canRemoveUsers) || roles === null) {
    return { self, canChange: false, canRemove: false };
  }
  const current = member.role ? roles.find((r) => r.id === member.role?.id) : undefined;
  if (member.role && !current) return { self, canChange: false, canRemove: false };
  const verdict = canManageMember(access.actor, {
    userId: member.userId,
    role: current ? roleViewOf(current) : null,
  });
  const ok = verdict === 'ok';
  return { self, canChange: ok && access.canEditUsers, canRemove: ok && access.canRemoveUsers };
}

/** Revoking an invitation: `platform.users.invite` and its role must be grantable (api rule). */
export function canRevokeInvitation(
  access: UsersAccess,
  invitation: Invitation,
  roles: readonly Role[] | null,
): boolean {
  if (!access.canInvite || roles === null) return false;
  const role = roles.find((r) => r.id === invitation.role.id);
  return role !== undefined && canGrantRole(access.actor, roleViewOf(role));
}

/** Editing a custom role: `platform.roles.edit` and its keys ⊆ the actor's keys. */
export function canEditCustomRole(access: UsersAccess, role: Role): boolean {
  return (
    role.systemKey === null &&
    access.canEditRoles &&
    canEditRole(access.actor, new Set(role.permissions), new Set())
  );
}

/** Deleting a custom role: `platform.roles.delete` and its keys ⊆ the actor's keys. */
export function canDeleteCustomRole(access: UsersAccess, role: Role): boolean {
  return (
    role.systemKey === null &&
    access.canDeleteRoles &&
    canEditRole(access.actor, new Set(role.permissions), new Set())
  );
}

/** Whether the role editor may offer `key`: only keys the actor holds. */
export function canOfferPermission(access: UsersAccess, key: PermissionKey): boolean {
  return access.actor.permissions.has(key);
}

export interface PermissionGroup {
  /** The key's first two segments, e.g. `platform.users`. */
  area: string;
  keys: PermissionKey[];
}

/** Registered keys grouped by area, in registry order; unknown keys are dropped. */
export function permissionGroups(keys: Iterable<string> = PERMISSION_KEYS): PermissionGroup[] {
  const wanted = new Set(keys);
  const groups = new Map<string, PermissionKey[]>();
  for (const key of PERMISSION_KEYS) {
    if (!wanted.has(key)) continue;
    const area = key.split('.').slice(0, 2).join('.');
    groups.set(area, [...(groups.get(area) ?? []), key]);
  }
  return [...groups].map(([area, list]) => ({ area, keys: list }));
}

export const isLocationScoped = (key: PermissionKey): boolean =>
  PERMISSIONS[key].scope === 'location';

/** Label of an area: `<module>.permissionAreas.<entity>`, e.g. `platform.permissionAreas.users`. */
export function areaLabel(area: string): LabelKey {
  const [module = '', entity = ''] = area.split('.');
  const key = `${module}.permissionAreas.${entity}`;
  return isLabelKey(key) ? key : 'platform.rolesPage.otherArea';
}

/** Display name of a permission key (every registered key has a label; a test checks it). */
export function permissionLabel(key: PermissionKey): LabelKey {
  const label = PERMISSIONS[key].label;
  return isLabelKey(label) ? label : 'platform.rolesPage.otherArea';
}
