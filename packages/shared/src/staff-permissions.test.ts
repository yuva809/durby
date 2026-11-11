import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from './permissions';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_ACTION_KEYS,
  PLATFORM_AUDIT_ENTITY_TYPES,
} from './platform-audit';
import {
  isStaffPermissionKey,
  STAFF_PERMISSION_KEYS,
  STAFF_ROLE_PERMISSIONS,
  STAFF_ROLES,
} from './staff-permissions';
import { staffErrorLabel } from './api/staff';

describe('staff permissions', () => {
  it('uses staff.entity.action keys, never a customer key', () => {
    for (const key of STAFF_PERMISSION_KEYS) {
      expect(key).toMatch(/^staff(\.[a-z][a-zA-Z0-9]*){2}$/);
      expect(PERMISSION_KEYS as readonly string[]).not.toContain(key);
    }
    // ...and no customer key could pass as a staff key.
    for (const key of PERMISSION_KEYS) expect(isStaffPermissionKey(key)).toBe(false);
    expect(isStaffPermissionKey('toString')).toBe(false);
  });

  it('gives the super admin everything; onboarding creates customers, support only reads and resends', () => {
    expect([...STAFF_ROLE_PERMISSIONS.super_admin].sort()).toEqual(
      [...STAFF_PERMISSION_KEYS].sort(),
    );
    for (const role of STAFF_ROLES) {
      expect(STAFF_ROLE_PERMISSIONS[role]).toContain('staff.portal.access');
      expect(STAFF_ROLE_PERMISSIONS[role]).toContain('staff.customers.read');
    }
    expect(STAFF_ROLE_PERMISSIONS.onboarding).toContain('staff.customers.create');
    expect(STAFF_ROLE_PERMISSIONS.support).not.toContain('staff.customers.create');
    for (const role of ['onboarding', 'support'] as const) {
      expect(STAFF_ROLE_PERMISSIONS[role]).not.toContain('staff.staff.manage');
    }
  });

  // Admin portal 1d: everyone sees a customer's modules; onboarding and super admins change them.
  it('lets onboarding manage modules and support only read them', () => {
    for (const role of STAFF_ROLES) {
      expect(STAFF_ROLE_PERMISSIONS[role]).toContain('staff.entitlements.read');
    }
    expect(STAFF_ROLE_PERMISSIONS.onboarding).toContain('staff.entitlements.manage');
    expect(STAFF_ROLE_PERMISSIONS.support).not.toContain('staff.entitlements.manage');
  });
});

describe('platform audit registry', () => {
  it('uses staff.entity.past_tense actions on known entity types', () => {
    for (const key of PLATFORM_AUDIT_ACTION_KEYS) {
      expect(key).toMatch(/^[a-z]+(\.[a-z_]+){2,}$/);
      expect(PLATFORM_AUDIT_ENTITY_TYPES).toContain(PLATFORM_AUDIT_ACTIONS[key].entityType);
    }
  });
});

describe('staff api schemas', () => {
  it('maps error codes to labels', () => {
    expect(staffErrorLabel('staff.last_super_admins')).toBe('staff.errors.lastSuperAdmins');
  });
});
