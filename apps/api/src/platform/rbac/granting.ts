import {
  canEditRole as sharedCanEditRole,
  canGrantRole as sharedCanGrantRole,
  canManageMember as sharedCanManageMember,
  type GrantingActor,
  type RoleView,
} from '@durby/shared';
import type { ResolvedAccess } from './access';

export type { RoleView } from '@durby/shared';

export interface Actor {
  userId: string;
  access: ResolvedAccess;
}

/** The rules live in packages/shared (ADR 0015 §13); the api applies them to the resolved access. */
const granting = (actor: Actor): GrantingActor => ({
  userId: actor.userId,
  systemRole: actor.access.systemRole,
  permissions: actor.access.permissions,
});

export function canGrantRole(actor: Actor, role: RoleView): boolean {
  return sharedCanGrantRole(granting(actor), role);
}

export function canManageMember(
  actor: Actor,
  target: { userId: string; role: RoleView | null },
): 'ok' | 'self' | 'not_grantable' {
  return sharedCanManageMember(granting(actor), target);
}

export function canEditRole(
  actor: Actor,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): boolean {
  return sharedCanEditRole(granting(actor), before, after);
}
