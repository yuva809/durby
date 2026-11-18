import { describe, expect, it } from 'vitest';
import {
  SYSTEM_ROLE_FEATURES,
  isPermissionKey,
  MATRIX_COLUMNS,
  type MatrixPlacement,
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

  // ADR 0050: every key sits in exactly one cell of the Manage Staff matrix.
  it('places every key in one matrix cell of a row of its own module', () => {
    const cells = new Map<string, string>();
    for (const key of PERMISSION_KEYS) {
      const placement: MatrixPlacement = PERMISSIONS[key].matrix;
      const { row, column, note } = placement;
      expect(MATRIX_COLUMNS).toContain(column);
      expect(row).toMatch(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/);
      expect(row.split('.')[0]).toBe(key.split('.')[0]);
      if (note !== undefined)
        expect(note.startsWith(`${key.split('.')[0]}.permissionNotes.`)).toBe(true);
      const cell = `${row}:${column}`;
      expect(cells.get(cell), `${key} and ${cells.get(cell)} share ${cell}`).toBeUndefined();
      cells.set(cell, key);
    }
  });

  it("lists a row's keys next to each other and a module's rows together", () => {
    const rows = PERMISSION_KEYS.map((key) => PERMISSIONS[key].matrix.row);
    const runs = rows.filter((row, i) => row !== rows[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
    const modules = runs.map((row) => row.split('.')[0]);
    const moduleRuns = modules.filter((m, i) => m !== modules[i - 1]);
    expect(new Set(moduleRuns).size).toBe(moduleRuns.length);
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

  it('keeps admin below owner, and staff to reading settings, products, tables and orders', () => {
    expect(systemRolePermissions('admin').has('platform.org.manage')).toBe(false);
    expect(systemRolePermissions('admin').has('platform.roles.manage')).toBe(true);
    expect(systemRolePermissions('admin').has('catalog.products.edit')).toBe(true);
    expect([...systemRolePermissions('manager')].sort()).toEqual([
      'catalog.products.read',
      'inventory.costs.read',
      'inventory.invoices.approve',
      'inventory.recipes.create',
      'inventory.recipes.delete',
      'inventory.recipes.edit',
      'inventory.stock.adjust',
      'inventory.stock.produce',
      'inventory.stock.read',
      'inventory.stock.receive',
      'inventory.stock.transfer',
      'inventory.warehouses.create',
      'inventory.warehouses.delete',
      'inventory.warehouses.edit',
      'orders.customers.create',
      'orders.customers.edit',
      'orders.customers.read',
      'orders.delivery.assign',
      'orders.delivery.use',
      'orders.orders.create',
      'orders.orders.edit',
      'orders.orders.read',
      'orders.picking.use',
      'orders.requests.create',
      'orders.requests.read',
      'orders.requests.receive',
      'platform.feedback.send',
      'platform.roles.read',
      'platform.settings.read',
      'platform.users.invite',
      'platform.users.read',
      'pos.bar.use',
      'pos.bills.cancel',
      'pos.bills.print',
      'pos.kitchen.use',
      'pos.orders.close',
      'pos.orders.discount',
      'pos.orders.read',
      'pos.orders.take',
      'pos.orders.void',
      'pos.tables.create',
      'pos.tables.delete',
      'pos.tables.edit',
      'pos.tables.read',
      'reservations.bookings.create',
      'reservations.bookings.delete',
      'reservations.bookings.edit',
      'reservations.bookings.read',
      'reservations.setup.create',
      'reservations.setup.delete',
      'reservations.setup.edit',
      'reservations.waitlist.create',
      'reservations.waitlist.delete',
      'reservations.waitlist.edit',
    ]);
    expect([...systemRolePermissions('staff')].sort()).toEqual([
      'catalog.products.read',
      'inventory.stock.read',
      'orders.customers.read',
      'orders.orders.read',
      'platform.feedback.send',
      'platform.settings.read',
      'pos.tables.read',
    ]);
  });

  // ADR 0045: the branch roles of a distribution business, each to its part of the flow.
  it('gives Branch, Warehouse and Driver their part of the stock request flow, nothing else', () => {
    expect([...systemRolePermissions('branch')].sort()).toEqual([
      'inventory.stock.read',
      'orders.requests.create',
      'orders.requests.read',
      'orders.requests.receive',
      'platform.feedback.send',
      'platform.settings.read',
    ]);
    expect([...systemRolePermissions('warehouse')].sort()).toEqual([
      'inventory.stock.adjust',
      'inventory.stock.read',
      'inventory.stock.receive',
      'orders.delivery.assign',
      'orders.orders.read',
      'orders.picking.use',
      'orders.requests.read',
      'platform.feedback.send',
      'platform.settings.read',
    ]);
    expect([...systemRolePermissions('driver')].sort()).toEqual([
      'orders.delivery.use',
      'platform.feedback.send',
    ]);
    const holders = (key: PermissionKey) =>
      SYSTEM_ROLES.filter((role) => systemRolePermissions(role).has(key));
    expect(holders('orders.requests.approve')).toEqual(['owner', 'admin']);
    expect(SYSTEM_ROLE_FEATURES).toEqual({
      waiter: 'pos',
      cashier: 'pos',
      host: 'reservations',
      kitchen: 'pos',
      bar: 'pos',
      branch: 'orders',
      warehouse: 'orders',
      driver: 'orders',
    });
  });

  // docs/modules/pos.md → Step 3: voids are for managers; the counter reads and closes.
  it('lets waiters take orders and, like cashiers, print bills and close them', () => {
    expect([...systemRolePermissions('waiter')].sort()).toEqual([
      'catalog.products.read',
      'platform.feedback.send',
      'platform.settings.read',
      'pos.bills.print',
      'pos.orders.close',
      'pos.orders.read',
      'pos.orders.take',
      'pos.tables.read',
      'reservations.bookings.create',
      'reservations.bookings.delete',
      'reservations.bookings.edit',
      'reservations.bookings.read',
      'reservations.waitlist.create',
      'reservations.waitlist.delete',
      'reservations.waitlist.edit',
    ]);
    expect([...systemRolePermissions('cashier')].sort()).toEqual([
      'catalog.products.read',
      'platform.feedback.send',
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
      'reservations.bookings.create',
      'reservations.bookings.delete',
      'reservations.bookings.edit',
      'reservations.bookings.read',
      'reservations.setup.create',
      'reservations.setup.delete',
      'reservations.setup.edit',
      'reservations.waitlist.create',
      'reservations.waitlist.delete',
      'reservations.waitlist.edit',
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
    expect(holders('reservations.bookings.edit')).toEqual([
      'owner',
      'admin',
      'manager',
      'waiter',
      'host',
    ]);
    expect(holders('reservations.waitlist.edit')).toEqual([
      'owner',
      'admin',
      'manager',
      'waiter',
      'host',
    ]);
    expect(holders('reservations.setup.edit')).toEqual(['owner', 'admin', 'manager']);
  });

  // ADR 0026: a station's screen only; no prices, orders or menu editing.
  it('gives Kitchen and Bar their screen, the settings and their stores, nothing else', () => {
    // Inventory (docs/modules/inventory.md): their stores' stock, deliveries, waste and production (ADR 0038).
    const store = [
      'inventory.stock.adjust',
      'inventory.stock.produce',
      'inventory.stock.read',
      'inventory.stock.receive',
    ];
    expect([...systemRolePermissions('kitchen')].sort()).toEqual([
      ...store,
      'platform.feedback.send',
      'platform.settings.read',
      'pos.kitchen.use',
    ]);
    expect([...systemRolePermissions('bar')].sort()).toEqual([
      ...store,
      'platform.feedback.send',
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
      'platform.feedback.send',
      'platform.settings.read',
      'pos.tables.read',
      'reservations.bookings.create',
      'reservations.bookings.delete',
      'reservations.bookings.edit',
      'reservations.bookings.read',
      'reservations.waitlist.create',
      'reservations.waitlist.delete',
      'reservations.waitlist.edit',
    ]);
  });
});
