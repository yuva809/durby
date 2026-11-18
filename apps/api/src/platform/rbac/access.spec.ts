import { PERMISSIONS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  holds,
  holdsAnywhere,
  holdsAtWarehouse,
  type MembershipAccessRow,
  resolveAccess,
  roleKeysOf,
} from './access';
import type { PermissionRegistry } from './permission-registry';

/** The real registry plus one location-scope key (none exists yet). */
const registry: PermissionRegistry = {
  ...PERMISSIONS,
  'test.stock.adjust': { scope: 'location', label: 'test.stock.adjust' },
};

const row = (over: Partial<MembershipAccessRow> = {}): MembershipAccessRow => ({
  id: 'm1',
  allLocations: true,
  role: { id: 'r1', systemKey: null, permissions: [] },
  locations: [],
  ...over,
});

const custom = (keys: string[]) => ({
  id: 'r1',
  systemKey: null,
  permissions: keys.map((permissionKey) => ({ permissionKey })),
});

describe('roleKeysOf', () => {
  it('gives the owner every registered key, including ones added later', () => {
    expect(roleKeysOf(registry, 'owner', []).has('test.stock.adjust')).toBe(true);
  });

  it('denies other system roles keys their grants do not list', () => {
    const admin = roleKeysOf(registry, 'admin', ['platform.org.manage']);
    expect(admin.has('platform.roles.edit')).toBe(true);
    expect(admin.has('platform.org.manage')).toBe(false);
    expect(admin.has('test.stock.adjust')).toBe(false);
  });

  it('ignores stored keys of a custom role that are not registered', () => {
    expect([...roleKeysOf(registry, null, ['platform.users.read', 'gone.key.removed'])]).toEqual([
      'platform.users.read',
    ]);
  });
});

describe('resolveAccess', () => {
  it('grants nothing without a membership or without a role', () => {
    expect(resolveAccess(registry, null).permissions.size).toBe(0);
    const noRole = resolveAccess(registry, row({ role: null }));
    expect(noRole.membershipId).toBe('m1');
    expect(noRole.permissions.size).toBe(0);
  });

  it('drops organization-scope keys for a location-limited membership', () => {
    const access = resolveAccess(
      registry,
      row({
        allLocations: false,
        role: custom(['platform.users.read', 'test.stock.adjust']),
        locations: [{ locationId: 'L1' }],
      }),
    );
    expect([...access.permissions]).toEqual(['test.stock.adjust']);
    expect([...access.roleKeys].sort()).toEqual(['platform.users.read', 'test.stock.adjust']);
  });

  it('a location-limited membership without location rows covers no location', () => {
    const access = resolveAccess(
      registry,
      row({ allLocations: false, role: custom(['test.stock.adjust']) }),
    );
    expect(holdsAnywhere(access, 'test.stock.adjust')).toBe(false);
    expect(holds(access, registry, 'test.stock.adjust', 'L1')).toBe(false);
  });
});

describe('holds', () => {
  const scoped = resolveAccess(
    registry,
    row({
      allLocations: false,
      role: custom(['test.stock.adjust']),
      locations: [{ locationId: 'L1' }],
    }),
  );
  const everywhere = resolveAccess(registry, row({ role: custom(['test.stock.adjust']) }));

  it('checks location-scope keys per location', () => {
    expect(holds(scoped, registry, 'test.stock.adjust', 'L1')).toBe(true);
    expect(holds(scoped, registry, 'test.stock.adjust', 'L2')).toBe(false);
    expect(holds(everywhere, registry, 'test.stock.adjust', 'L2')).toBe(true);
  });

  it('without a location, a location-scope key counts only when it covers every location', () => {
    expect(holds(scoped, registry, 'test.stock.adjust')).toBe(false);
    expect(holds(everywhere, registry, 'test.stock.adjust')).toBe(true);
    expect(holdsAnywhere(scoped, 'test.stock.adjust')).toBe(true);
  });

  it('organization-scope keys ignore the location', () => {
    const admin = resolveAccess(
      registry,
      row({ role: { id: 'r', systemKey: 'admin', permissions: [] } }),
    );
    expect(holds(admin, registry, 'platform.users.read', 'any-location')).toBe(true);
    expect(holds(admin, registry, 'platform.org.manage')).toBe(false);
  });
});

describe('per-member overrides and deactivation (ADR 0023)', () => {
  const override = (permissionKey: string, effect: 'grant' | 'deny') => ({ permissionKey, effect });

  it('adds grants to the role and takes denies away', () => {
    const access = resolveAccess(
      registry,
      row({
        role: custom(['pos.orders.read', 'pos.orders.take']),
        permissions: [override('pos.bills.print', 'grant'), override('pos.orders.take', 'deny')],
      }),
    );
    expect([...access.permissions].sort()).toEqual(['pos.bills.print', 'pos.orders.read']);
    expect([...access.roleKeys].sort()).toEqual(['pos.orders.read', 'pos.orders.take']);
  });

  it('ignores unregistered override keys (fail closed)', () => {
    const access = resolveAccess(
      registry,
      row({ role: custom([]), permissions: [override('gone.key.removed', 'grant')] }),
    );
    expect(access.permissions.size).toBe(0);
  });

  it('never takes anything from an Owner', () => {
    const access = resolveAccess(
      registry,
      row({
        role: { id: 'r1', systemKey: 'owner', permissions: [] },
        permissions: [override('platform.users.edit', 'deny')],
      }),
    );
    expect(access.permissions.has('platform.users.edit')).toBe(true);
  });

  it('applies the location rule after the overrides', () => {
    const access = resolveAccess(
      registry,
      row({
        allLocations: false,
        locations: [{ locationId: 'l1' }],
        role: custom([]),
        permissions: [
          override('platform.users.read', 'grant'),
          override('test.stock.adjust', 'grant'),
        ],
      }),
    );
    expect([...access.permissions]).toEqual(['test.stock.adjust']);
  });

  it('gives a deactivated member no access', () => {
    const access = resolveAccess(
      registry,
      row({ role: custom(['pos.orders.read']), deactivatedAt: new Date() }),
    );
    expect(access.membershipId).toBeNull();
    expect(access.permissions.size).toBe(0);
  });
});

describe('holdsAtWarehouse (ADR 0057)', () => {
  const A = { id: 'W-A', locationId: 'L1' };
  const B = { id: 'W-B', locationId: 'L1' };
  const elsewhere = { id: 'W-C', locationId: 'L2' };

  it('limits a member with warehouses to those, at their locations', () => {
    const limited = resolveAccess(
      registry,
      row({
        allLocations: false,
        role: custom(['test.stock.adjust']),
        locations: [{ locationId: 'L1' }],
        warehouseIds: ['W-A'],
      }),
    );
    expect(limited.warehouseIds).toEqual(new Set(['W-A']));
    expect(holdsAtWarehouse(limited, registry, 'test.stock.adjust', A)).toBe(true);
    expect(holdsAtWarehouse(limited, registry, 'test.stock.adjust', B)).toBe(false);
    expect(holdsAtWarehouse(limited, registry, 'test.stock.adjust', elsewhere)).toBe(false);
    // The location rule still applies: a warehouse id alone never opens another location.
    expect(holds(limited, registry, 'test.stock.adjust', 'L1')).toBe(true);
  });

  it('lets a member without warehouses use every warehouse at their locations', () => {
    const plain = resolveAccess(
      registry,
      row({
        allLocations: false,
        role: custom(['test.stock.adjust']),
        locations: [{ locationId: 'L1' }],
      }),
    );
    expect(plain.warehouseIds).toBeNull();
    expect(holdsAtWarehouse(plain, registry, 'test.stock.adjust', B)).toBe(true);
    expect(holdsAtWarehouse(plain, registry, 'test.stock.adjust', elsewhere)).toBe(false);
  });

  it('never limits an owner, whatever is stored', () => {
    const owner = resolveAccess(
      registry,
      row({ role: { id: 'r', systemKey: 'owner', permissions: [] }, warehouseIds: ['W-A'] }),
    );
    expect(owner.warehouseIds).toBeNull();
  });
});
