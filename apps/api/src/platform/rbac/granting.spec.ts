import { PERMISSIONS, type SystemRole } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { resolveAccess, roleKeysOf } from './access';
import { canEditRole, canGrantRole, canManageMember, type RoleView } from './granting';

const system = (key: SystemRole): RoleView => ({
  systemKey: key,
  keys: roleKeysOf(PERMISSIONS, key, []),
});
const custom = (keys: string[]): RoleView => ({ systemKey: null, keys: new Set(keys) });

const actor = (role: RoleView, userId = 'actor', allLocations = true) => ({
  userId,
  access: resolveAccess(PERMISSIONS, {
    id: 'm',
    allLocations,
    role: {
      id: 'r',
      systemKey: role.systemKey,
      permissions: [...role.keys].map((permissionKey) => ({ permissionKey })),
    },
    locations: [],
  }),
});

const owner = actor(system('owner'));
const admin = actor(system('admin'));
const manager = actor(system('manager'));

describe('canGrantRole', () => {
  it('only an owner can grant Owner', () => {
    expect(canGrantRole(owner, system('owner'))).toBe(true);
    expect(canGrantRole(admin, system('owner'))).toBe(false);
  });

  it('allows roles whose keys are a subset of the actor keys', () => {
    expect(canGrantRole(admin, system('admin'))).toBe(true);
    expect(canGrantRole(admin, system('staff'))).toBe(true);
    expect(canGrantRole(manager, system('staff'))).toBe(true);
    expect(canGrantRole(manager, system('manager'))).toBe(true);
    expect(canGrantRole(manager, system('admin'))).toBe(false);
    expect(canGrantRole(manager, custom(['platform.users.read']))).toBe(true);
    expect(canGrantRole(manager, custom(['platform.users.read', 'platform.users.manage']))).toBe(
      false,
    );
  });

  it('a location-limited actor holds no organization keys, so grants nothing that needs one', () => {
    const scoped = actor(system('owner'), 'actor', false);
    expect(canGrantRole(scoped, custom(['platform.users.read']))).toBe(false);
    expect(canGrantRole(scoped, system('staff'))).toBe(true);
  });
});

describe('canManageMember', () => {
  it('never lets anyone change or remove themselves', () => {
    expect(canManageMember(owner, { userId: 'actor', role: system('staff') })).toBe('self');
  });

  it('only an owner can change or remove an owner', () => {
    expect(canManageMember(owner, { userId: 'b', role: system('owner') })).toBe('ok');
    expect(canManageMember(admin, { userId: 'b', role: system('owner') })).toBe('not_grantable');
  });

  it('only members whose role is a subset of the actor keys', () => {
    expect(canManageMember(admin, { userId: 'b', role: system('admin') })).toBe('ok');
    expect(canManageMember(manager, { userId: 'b', role: system('admin') })).toBe('not_grantable');
    expect(canManageMember(manager, { userId: 'b', role: system('staff') })).toBe('ok');
    expect(canManageMember(manager, { userId: 'b', role: null })).toBe('ok');
    expect(canManageMember(admin, { userId: 'b', role: custom(['platform.org.manage']) })).toBe(
      'not_grantable',
    );
  });
});

describe('canEditRole', () => {
  it('requires the role keys before and after to be a subset of the actor keys', () => {
    const roleManager = actor(custom(['platform.roles.manage', 'platform.users.read']));
    expect(canEditRole(roleManager, new Set(), new Set(['platform.users.read']))).toBe(true);
    expect(canEditRole(roleManager, new Set(), new Set(['platform.users.manage']))).toBe(false);
    // Removing a key the actor doesn't hold demotes others beyond the actor's own level.
    expect(
      canEditRole(
        roleManager,
        new Set(['platform.users.manage']),
        new Set(['platform.users.read']),
      ),
    ).toBe(false);
    expect(canEditRole(owner, new Set(['platform.org.manage']), new Set())).toBe(true);
  });
});
