/**
 * Durby staff permissions (docs/platform/admin-portal.md, ADR 0017 §2). A registry of its own,
 * apart from the customer PERMISSION_REGISTRY: no customer role can ever hold one of these keys.
 *
 * Adding a key: `staff.<entity>.<action>`, a label with `en` and `de` defaults, and its grant in
 * STAFF_ROLE_PERMISSIONS (a test fails without them).
 */

export const STAFF_PERMISSIONS = {
  'staff.portal.access': { label: 'staff.permissions.portalAccess' },
  'staff.staff.read': { label: 'staff.permissions.staffRead' },
  'staff.staff.manage': { label: 'staff.permissions.staffManage' },
  'staff.audit.read': { label: 'staff.permissions.auditRead' },
  'staff.customers.read': { label: 'staff.permissions.customersRead' },
  'staff.customers.create': { label: 'staff.permissions.customersCreate' },
  'staff.customers.invite': { label: 'staff.permissions.customersInvite' },
} as const satisfies Record<string, { label: string }>;

export type StaffPermissionKey = keyof typeof STAFF_PERMISSIONS;

export const STAFF_PERMISSION_KEYS = Object.keys(
  STAFF_PERMISSIONS,
) as readonly StaffPermissionKey[];

export function isStaffPermissionKey(value: string): value is StaffPermissionKey {
  return Object.prototype.hasOwnProperty.call(STAFF_PERMISSIONS, value);
}

/** Staff roles, fixed in code until custom staff roles (Phase 4). `billing` joins in Phase 2. */
export const STAFF_ROLES = ['super_admin', 'onboarding', 'support'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * What each role holds (business rules → Staff roles). SuperAdmin holds every key, including future
 * ones; Onboarding creates customers; Support views them and resends invites.
 */
export const STAFF_ROLE_PERMISSIONS: Record<StaffRole, readonly StaffPermissionKey[]> = {
  super_admin: STAFF_PERMISSION_KEYS,
  onboarding: [
    'staff.portal.access',
    'staff.customers.read',
    'staff.customers.create',
    'staff.customers.invite',
  ],
  support: ['staff.portal.access', 'staff.customers.read', 'staff.customers.invite'],
};

export function staffRoleLabel(role: StaffRole): string {
  return `staff.roles.${role.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
