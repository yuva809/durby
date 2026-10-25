import type { SystemRole } from './permissions';

/**
 * Granting rules (docs/platform/rbac.md → Granting rules, ADR 0015 §13). Pure functions shared by
 * the api, which enforces them, and the web app, which hides what the api would refuse.
 */

/** A role as the granting rules see it: its system key and its registered keys. */
export interface RoleView {
  systemKey: SystemRole | null;
  keys: ReadonlySet<string>;
}

/**
 * The actor: their system role and effective keys in the organization (organization-scope keys
 * only when the membership covers all locations). The web app passes the session's hints.
 */
export interface GrantingActor {
  userId: string;
  systemRole: SystemRole | null;
  permissions: ReadonlySet<string>;
}

const subset = (keys: ReadonlySet<string>, of: ReadonlySet<string>): boolean =>
  [...keys].every((key) => of.has(key));

/**
 * Whether the actor may invite with or assign `role`: Owner only by an Owner; any other role only
 * if its keys are a subset of the actor's keys.
 */
export function canGrantRole(actor: GrantingActor, role: RoleView): boolean {
  if (role.systemKey === 'owner') return actor.systemRole === 'owner';
  return subset(role.keys, actor.permissions);
}

/**
 * Whether the actor may change or remove the member: never themselves; an Owner only by an
 * Owner; anyone else only if their current role is a subset of the actor's keys.
 */
export function canManageMember(
  actor: GrantingActor,
  target: { userId: string; role: RoleView | null },
): 'ok' | 'self' | 'not_grantable' {
  if (target.userId === actor.userId) return 'self';
  if (target.role === null) return 'ok';
  return canGrantRole(actor, target.role) ? 'ok' : 'not_grantable';
}

/** Creating, editing or deleting a custom role: its keys before and after ⊆ the actor's keys. */
export function canEditRole(
  actor: Pick<GrantingActor, 'permissions'>,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): boolean {
  return subset(before, actor.permissions) && subset(after, actor.permissions);
}
