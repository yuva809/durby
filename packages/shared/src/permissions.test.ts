import { describe, expect, it } from 'vitest';
import {
  isPermissionKey,
  PERMISSION_KEYS,
  PERMISSIONS,
  SYSTEM_ROLE_GRANTS,
  SYSTEM_ROLES,
  systemRolePermissions,
} from './permissions';

describe('permission registry', () => {
  it('uses module.entity.action keys with a scope and a label key', () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*){2,}$/);
      expect(['organization', 'location']).toContain(PERMISSIONS[key].scope);
      expect(PERMISSIONS[key].label).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
    }
  });

  it('recognizes registered keys only', () => {
    expect(isPermissionKey('platform.users.invite')).toBe(true);
    expect(isPermissionKey('platform.users.delete_everything')).toBe(false);
    expect(isPermissionKey('toString')).toBe(false);
  });
});

describe('system roles', () => {
  it('gives the owner every registered key', () => {
    expect([...systemRolePermissions('owner')].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  // Every new key forces a decision for each non-owner system role (ADR 0007).
  it.each(SYSTEM_ROLES.filter((role) => role !== 'owner'))(
    '%s lists every registered key as grant or deny',
    (role) => {
      const grants = SYSTEM_ROLE_GRANTS[role];
      expect(Object.keys(grants).sort()).toEqual([...PERMISSION_KEYS].sort());
      for (const decision of Object.values(grants)) expect(['grant', 'deny']).toContain(decision);
    },
  );

  it('keeps admin below owner and staff without platform keys', () => {
    expect(systemRolePermissions('admin').has('platform.org.manage')).toBe(false);
    expect(systemRolePermissions('admin').has('platform.roles.manage')).toBe(true);
    expect([...systemRolePermissions('manager')].sort()).toEqual([
      'platform.roles.read',
      'platform.users.invite',
      'platform.users.read',
    ]);
    expect(systemRolePermissions('staff').size).toBe(0);
  });
});
