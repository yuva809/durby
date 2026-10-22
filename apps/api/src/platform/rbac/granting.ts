import type { SystemRole } from '@durby/shared';
import type { ResolvedAccess } from './access';

/** A role as the granting rules see it: its system key and its registered keys. */
export interface RoleView {
  systemKey: SystemRole | null;
  keys: ReadonlySet<string>;
}

export interface Actor {
  userId: string;
  access: ResolvedAccess;
}

const subset = (keys: ReadonlySet<string>, of: ReadonlySet<string>): boolean =>
  [...keys].every((key) => of.has(key));

/**
 * Whether the actor may invite with or assign `role` (docs/platform/rbac.md → Granting rules):
 * Owner only by an Owner; any other role only if its keys are a subset of the actor's keys
 * (the actor's effective keys: organization-scope keys only when they cover all locations).
 */
export function canGrantRole(actor: Actor, role: RoleView): boolean {
  if (role.systemKey === 'owner') return actor.access.systemRole === 'owner';
  return subset(role.keys, actor.access.permissions);
}

/**
 * Whether the actor may change or remove the member: never themselves; an Owner only by an
 * Owner; anyone else only if their current role is a subset of the actor's keys.
 */
export function canManageMember(
  actor: Actor,
  target: { userId: string; role: RoleView | null },
): 'ok' | 'self' | 'not_grantable' {
  if (target.userId === actor.userId) return 'self';
  if (target.role === null) return 'ok';
  return canGrantRole(actor, target.role) ? 'ok' : 'not_grantable';
}

/** Creating, editing or deleting a custom role: its keys before and after ⊆ the actor's keys. */
export function canEditRole(
  actor: Actor,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): boolean {
  return subset(before, actor.access.permissions) && subset(after, actor.access.permissions);
}
