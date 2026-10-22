import { PERMISSIONS } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  holds,
  holdsAnywhere,
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
    expect(admin.has('platform.roles.manage')).toBe(true);
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
