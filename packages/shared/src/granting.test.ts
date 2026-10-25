import { describe, expect, it } from 'vitest';
import {
  canEditRole,
  canGrantRole,
  canManageMember,
  type GrantingActor,
  type RoleView,
} from './granting';
import { type SystemRole, systemRolePermissions } from './permissions';

const system = (key: SystemRole): RoleView => ({
  systemKey: key,
  keys: systemRolePermissions(key),
});
const custom = (keys: string[]): RoleView => ({ systemKey: null, keys: new Set(keys) });
const actor = (role: SystemRole, userId = 'actor'): GrantingActor => ({
  userId,
  systemRole: role,
  permissions: systemRolePermissions(role),
});

describe('granting rules (shared by api and web)', () => {
  it('only an Owner grants Owner', () => {
    expect(canGrantRole(actor('owner'), system('owner'))).toBe(true);
    expect(canGrantRole(actor('admin'), system('owner'))).toBe(false);
  });

  it('grants a role only when its keys are a subset of the actor keys', () => {
    expect(canGrantRole(actor('admin'), system('admin'))).toBe(true);
    expect(canGrantRole(actor('manager'), system('staff'))).toBe(true);
    expect(canGrantRole(actor('manager'), system('admin'))).toBe(false);
    expect(canGrantRole(actor('manager'), custom(['platform.users.manage']))).toBe(false);
    // A custom-role actor: no system role, only its keys.
    const lead = { userId: 'a', systemRole: null, permissions: new Set(['platform.users.read']) };
    expect(canGrantRole(lead, custom(['platform.users.read']))).toBe(true);
    expect(canGrantRole(lead, system('staff'))).toBe(false);
  });

  it('never manages yourself; Owners only by Owners; others by the subset rule', () => {
    expect(canManageMember(actor('owner'), { userId: 'actor', role: system('staff') })).toBe(
      'self',
    );
    expect(canManageMember(actor('admin'), { userId: 'm', role: system('owner') })).toBe(
      'not_grantable',
    );
    expect(canManageMember(actor('owner'), { userId: 'm', role: system('owner') })).toBe('ok');
    expect(canManageMember(actor('admin'), { userId: 'm', role: system('manager') })).toBe('ok');
    expect(canManageMember(actor('manager'), { userId: 'm', role: system('admin') })).toBe(
      'not_grantable',
    );
    expect(canManageMember(actor('manager'), { userId: 'm', role: null })).toBe('ok');
  });

  it('edits a custom role only within the actor keys, before and after', () => {
    const manager = actor('manager');
    const read = new Set(['platform.users.read']);
    const manage = new Set(['platform.users.manage']);
    expect(canEditRole(manager, new Set(), read)).toBe(true);
    expect(canEditRole(manager, new Set(), manage)).toBe(false);
    expect(canEditRole(manager, manage, read)).toBe(false);
  });
});
