import type { SystemRole } from '@durby/shared';
import { effectiveKeysOf } from './access';
import type { Actor } from './granting';
import type { PermissionRegistry } from './permission-registry';
import { rbacErrors } from './rbac-errors';

/** Per-member changes to a role's keys (ADR 0023 §1). */
export interface Overrides {
  grants: string[];
  denies: string[];
}

export const NO_OVERRIDES: Overrides = { grants: [], denies: [] };

/**
 * The overrides worth storing: registered keys only (400 rbac.permission_unknown otherwise), a
 * grant only for a key the role lacks, a deny only for a key the role has, in registry order. An
 * Owner keeps none (they hold every key).
 */
export function normalizeOverrides(
  registry: PermissionRegistry,
  role: { systemKey: SystemRole | null; keys: ReadonlySet<string> },
  input: Overrides,
): Overrides {
  const unknown = [...new Set([...input.grants, ...input.denies])].filter(
    (key) => !Object.hasOwn(registry, key),
  );
  if (unknown.length > 0) throw rbacErrors.permissionUnknown(unknown);
  if (role.systemKey === 'owner') return { grants: [], denies: [] };
  const grants = new Set(input.grants);
  const denies = new Set(input.denies);
  const ordered = Object.keys(registry);
  return {
    grants: ordered.filter((key) => grants.has(key) && !role.keys.has(key)),
    denies: ordered.filter((key) => denies.has(key) && role.keys.has(key)),
  };
}

/** Keys added to or removed from either list between `before` and `after`. */
function changedKeys(before: Overrides, after: Overrides): string[] {
  const diff = (a: string[], b: string[]) => a.filter((key) => !b.includes(key));
  return [
    ...diff(after.grants, before.grants),
    ...diff(before.grants, after.grants),
    ...diff(after.denies, before.denies),
    ...diff(before.denies, after.denies),
  ];
}

/** An actor may set or clear a grant or a deny only for keys they hold (ADR 0023 §2). */
export function canSetOverrides(actor: Actor, before: Overrides, after: Overrides): boolean {
  return changedKeys(before, after).every((key) => actor.access.permissions.has(key));
}

/** A member's effective keys, as a RoleView for the granting rules (ADR 0023 §2). */
export function memberView(
  registry: PermissionRegistry,
  role: { systemKey: SystemRole | null; keys: ReadonlySet<string> },
  overrides: Overrides,
): { systemKey: SystemRole | null; keys: ReadonlySet<string> } {
  return {
    systemKey: role.systemKey,
    keys: effectiveKeysOf(registry, role.keys, role.systemKey, toRows(overrides)),
  };
}

/** Overrides as stored rows. */
export const toRows = (overrides: Overrides) => [
  ...overrides.grants.map((permissionKey) => ({ permissionKey, effect: 'grant' as const })),
  ...overrides.denies.map((permissionKey) => ({ permissionKey, effect: 'deny' as const })),
];

/** Stored rows as overrides. */
export function fromRows(
  rows: readonly { permissionKey: string; effect: 'grant' | 'deny' }[],
): Overrides {
  return {
    grants: rows.filter((r) => r.effect === 'grant').map((r) => r.permissionKey),
    denies: rows.filter((r) => r.effect === 'deny').map((r) => r.permissionKey),
  };
}
