/**
 * Permission key registry (`module.entity.action`). See docs/platform/rbac.md and ADR 0007.
 *
 * - `organization` scope: only memberships covering all locations can hold the key.
 * - `location` scope: held per location; location-limited memberships hold it for their locations.
 *
 * Adding a key: give it a scope and a label, then decide grant/deny in SYSTEM_ROLE_GRANTS for every
 * non-owner system role (the typecheck fails until you do). Owner gets it automatically.
 */
export type PermissionScope = 'organization' | 'location';

export interface PermissionDefinition {
  scope: PermissionScope;
  /** Label key of the permission's display name. */
  label: string;
}

export const PERMISSIONS = {
  'platform.org.manage': { scope: 'organization', label: 'platform.permissions.orgManage' },
  'platform.users.read': { scope: 'organization', label: 'platform.permissions.usersRead' },
  'platform.users.invite': { scope: 'organization', label: 'platform.permissions.usersInvite' },
  'platform.users.manage': { scope: 'organization', label: 'platform.permissions.usersManage' },
  'platform.roles.read': { scope: 'organization', label: 'platform.permissions.rolesRead' },
  'platform.roles.manage': { scope: 'organization', label: 'platform.permissions.rolesManage' },
  'platform.settings.manage': {
    scope: 'organization',
    label: 'platform.permissions.settingsManage',
  },
  'platform.labels.manage': { scope: 'organization', label: 'platform.permissions.labelsManage' },
  'platform.audit.read': { scope: 'organization', label: 'platform.permissions.auditRead' },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as readonly PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/** System roles, created in every organization. Display names are `platform.roles.<key>` labels. */
export const SYSTEM_ROLES = ['owner', 'admin', 'manager', 'staff'] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

type Grants = Readonly<Record<PermissionKey, 'grant' | 'deny'>>;

/**
 * Permissions of the non-owner system roles, the same for every organization (ADR 0007): a change
 * here changes the role for all tenants. Every key must be listed for every role.
 */
export const SYSTEM_ROLE_GRANTS: Readonly<Record<Exclude<SystemRole, 'owner'>, Grants>> = {
  admin: {
    'platform.org.manage': 'deny',
    'platform.users.read': 'grant',
    'platform.users.invite': 'grant',
    'platform.users.manage': 'grant',
    'platform.roles.read': 'grant',
    'platform.roles.manage': 'grant',
    'platform.settings.manage': 'grant',
    'platform.labels.manage': 'grant',
    'platform.audit.read': 'grant',
  },
  manager: {
    'platform.org.manage': 'deny',
    'platform.users.read': 'grant',
    'platform.users.invite': 'grant',
    'platform.users.manage': 'deny',
    'platform.roles.read': 'grant',
    'platform.roles.manage': 'deny',
    'platform.settings.manage': 'deny',
    'platform.labels.manage': 'deny',
    'platform.audit.read': 'deny',
  },
  staff: {
    'platform.org.manage': 'deny',
    'platform.users.read': 'deny',
    'platform.users.invite': 'deny',
    'platform.users.manage': 'deny',
    'platform.roles.read': 'deny',
    'platform.roles.manage': 'deny',
    'platform.settings.manage': 'deny',
    'platform.labels.manage': 'deny',
    'platform.audit.read': 'deny',
  },
};

/** The keys a system role holds. Owner holds every registered key, including future ones. */
export function systemRolePermissions(role: SystemRole): ReadonlySet<PermissionKey> {
  if (role === 'owner') return new Set(PERMISSION_KEYS);
  const grants = SYSTEM_ROLE_GRANTS[role];
  return new Set(PERMISSION_KEYS.filter((key) => grants[key] === 'grant'));
}
