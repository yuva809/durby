import { describe, expect, it } from 'vitest';
import {
  isPermissionKey,
  PERMISSION_KEYS,
  PERMISSIONS,
  SYSTEM_ROLE_GRANTS,
  SYSTEM_ROLES,
  systemRolePermissions,
  type PermissionKey,
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
      'inventory.costs.read',
      'inventory.recipes.manage',
      'inventory.stock.adjust',
      'inventory.stock.read',
      'inventory.stock.receive',
      'inventory.stock.transfer',
      'inventory.warehouses.manage',
      'platform.roles.read',
      'platform.settings.read',
      'platform.users.invite',
      'platform.users.read',
      'pos.bar.use',
      'pos.bills.print',
      'pos.kitchen.use',
      'pos.orders.close',
      'pos.orders.read',
      'pos.orders.take',
      'pos.orders.void',
      'pos.tables.manage',
      'pos.tables.read',
      'reservations.bookings.manage',
      'reservations.bookings.read',
      'reservations.setup.manage',
      'reservations.waitlist.manage',
    ]);
    expect([...systemRolePermissions('staff')].sort()).toEqual([
      'catalog.products.read',
      'inventory.stock.read',
      'platform.settings.read',
      'pos.tables.read',
    ]);
  });

  // docs/modules/pos.md → Step 3: voids are for managers; the counter reads and closes.
  it('lets waiters take orders and, like cashiers, print bills and close them', () => {
    expect([...systemRolePermissions('waiter')].sort()).toEqual([
      'catalog.products.read',
      'platform.settings.read',
      'pos.bills.print',
      'pos.orders.close',
      'pos.orders.read',
      'pos.orders.take',
      'pos.tables.read',
      'reservations.bookings.manage',
      'reservations.bookings.read',
      'reservations.waitlist.manage',
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

  // docs/modules/reservations.md → Permissions: every reservations key is location-scoped.
  it('scopes the reservations keys per location', () => {
    for (const key of PERMISSION_KEYS.filter((k) => k.startsWith('reservations.'))) {
      expect(PERMISSIONS[key].scope).toBe('location');
    }
    expect(PERMISSION_KEYS.filter((k) => k.startsWith('reservations.')).sort()).toEqual([
      'reservations.bookings.manage',
      'reservations.bookings.read',
      'reservations.setup.manage',
      'reservations.waitlist.manage',
    ]);
  });

  it('grants the reservations keys per role as the spec decides', () => {
    const holders = (key: PermissionKey) =>
      SYSTEM_ROLES.filter((role) => systemRolePermissions(role).has(key));
    expect(holders('reservations.bookings.read')).toEqual([
      'owner',
      'admin',
      'manager',
      'waiter',
      'host',
    ]);
    expect(holders('reservations.bookings.manage')).toEqual([
      'owner',
      'admin',
      'manager',
      'waiter',
      'host',
    ]);
    expect(holders('reservations.waitlist.manage')).toEqual([
      'owner',
      'admin',
      'manager',
      'waiter',
      'host',
    ]);
    expect(holders('reservations.setup.manage')).toEqual(['owner', 'admin', 'manager']);
  });

  // ADR 0026: a station's screen only; no prices, orders or menu editing.
  it('gives Kitchen and Bar their screen, the settings and their stores, nothing else', () => {
    // Inventory (docs/modules/inventory.md): their stores' stock, deliveries and waste.
    const store = ['inventory.stock.adjust', 'inventory.stock.read', 'inventory.stock.receive'];
    expect([...systemRolePermissions('kitchen')].sort()).toEqual([
      ...store,
      'platform.settings.read',
      'pos.kitchen.use',
    ]);
    expect([...systemRolePermissions('bar')].sort()).toEqual([
      ...store,
      'platform.settings.read',
      'pos.bar.use',
    ]);
    const holders = (key: PermissionKey) =>
      SYSTEM_ROLES.filter((role) => systemRolePermissions(role).has(key));
    expect(holders('pos.kitchen.use')).toEqual(['owner', 'admin', 'manager', 'kitchen']);
    expect(holders('pos.bar.use')).toEqual(['owner', 'admin', 'manager', 'bar']);
  });

  // The door: bookings, walk-ins and the waitlist, and which tables exist; no orders, menu or setup.
  it('gives the host the bookings, the waitlist and the tables, nothing else', () => {
    expect([...systemRolePermissions('host')].sort()).toEqual([
      'platform.settings.read',
      'pos.tables.read',
      'reservations.bookings.manage',
      'reservations.bookings.read',
      'reservations.waitlist.manage',
    ]);
  });
});
