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

  it('keeps admin below owner, and staff to reading settings, products and tables', () => {
    expect(systemRolePermissions('admin').has('platform.org.manage')).toBe(false);
    expect(systemRolePermissions('admin').has('platform.roles.manage')).toBe(true);
    expect(systemRolePermissions('admin').has('catalog.products.manage')).toBe(true);
    expect([...systemRolePermissions('manager')].sort()).toEqual([
      'catalog.products.read',
      'platform.roles.read',
      'platform.settings.read',
      'platform.users.invite',
      'platform.users.read',
      'pos.bills.print',
      'pos.orders.close',
      'pos.orders.read',
      'pos.orders.take',
      'pos.orders.void',
      'pos.tables.manage',
      'pos.tables.read',
    ]);
    expect([...systemRolePermissions('staff')].sort()).toEqual([
      'catalog.products.read',
      'platform.settings.read',
      'pos.tables.read',
    ]);
  });

  // docs/modules/pos.md → Step 3: voids are for managers; the counter reads and closes.
  it('lets waiters take and close orders, and cashiers read and close them', () => {
    expect([...systemRolePermissions('waiter')].sort()).toEqual([
      'catalog.products.read',
      'platform.settings.read',
      'pos.orders.close',
      'pos.orders.read',
      'pos.orders.take',
      'pos.tables.read',
    ]);
    expect([...systemRolePermissions('cashier')].sort()).toEqual([
      'catalog.products.read',
      'platform.settings.read',
      'pos.bills.print',
      'pos.orders.close',
      'pos.orders.read',
      'pos.tables.read',
    ]);
  });
});
