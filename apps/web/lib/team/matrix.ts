import {
  canManageMember,
  FEATURES,
  isFeatureKey,
  PERMISSION_KEYS,
  type PermissionKey,
  type TeamMember,
} from '@durby/shared';
import { isLabelKey, type LabelKey } from '@durby/i18n';
import { type PermissionGroup, permissionGroups, type UsersAccess } from '../users/access';

/**
 * Manage Staff in the browser (docs/platform/rbac.md → Manage Staff, ADR 0023): the permission
 * matrix and what the signed-in user may do. Hints only: the api applies the same rules.
 */

/** A key's module: its first segment (`pos.orders.take` → `pos`). */
export const moduleOf = (key: string): string => key.split('.')[0] ?? '';

/**
 * The permission areas to show: platform keys always; a module's keys only when its feature is
 * enabled for the organization. `hiddenModules` lists the switched-off ones (their name labels).
 */
export function visiblePermissions(activeFeatures: readonly string[]): {
  groups: PermissionGroup[];
  hiddenModules: LabelKey[];
} {
  const enabled = new Set(activeFeatures);
  const shown = (module: string) =>
    module === 'platform' || !isFeatureKey(module) || enabled.has(module);
  const modules = [...new Set(PERMISSION_KEYS.map(moduleOf))];
  return {
    groups: permissionGroups(PERMISSION_KEYS.filter((key) => shown(moduleOf(key)))),
    hiddenModules: modules
      .filter((module) => !shown(module))
      .flatMap((module) => {
        const label = isFeatureKey(module) ? FEATURES[module].label : null;
        return label && isLabelKey(label) ? [label] : [];
      }),
  };
}

/** The ticked keys: the role's keys with the member's grants added and denies taken away. */
export function selectedOf(
  roleKeys: ReadonlySet<string>,
  overrides: { grants: readonly string[]; denies: readonly string[] },
): Set<string> {
  const selected = new Set(roleKeys);
  for (const key of overrides.grants) selected.add(key);
  for (const key of overrides.denies) selected.delete(key);
  return selected;
}

/** What to send: grants = ticked but not in the role, denies = in the role but unticked. */
export function overridesOf(
  roleKeys: ReadonlySet<string>,
  selected: ReadonlySet<string>,
): { grants: PermissionKey[]; denies: PermissionKey[] } {
  return {
    grants: PERMISSION_KEYS.filter((key) => selected.has(key) && !roleKeys.has(key)),
    denies: PERMISSION_KEYS.filter((key) => !selected.has(key) && roleKeys.has(key)),
  };
}

/**
 * Whether the user may change a key's tick: only keys they hold themselves (ADR 0023 §2). Keys of a
 * hidden module stay as they are.
 */
export const canToggle = (access: UsersAccess, key: string): boolean =>
  access.actor.permissions.has(key);

export interface TeamRowActions {
  self: boolean;
  /** Edit, deactivate/reactivate: `platform.users.manage` and the member's keys ⊆ yours. */
  canManage: boolean;
}

/** The row's actions: never on yourself; members compared by their effective keys. */
export function teamRowActions(access: UsersAccess, member: TeamMember): TeamRowActions {
  const self = member.userId === access.actor.userId;
  if (self || !access.canManageUsers) return { self, canManage: false };
  const verdict = canManageMember(access.actor, {
    userId: member.userId,
    role: member.role
      ? { systemKey: member.role.systemKey, keys: new Set(member.permissions) }
      : null,
  });
  return { self, canManage: verdict === 'ok' };
}

/** Easy to read out and type: no 0/O, 1/l/I. */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A temporary password of `length` characters from the browser's CSPRNG. */
export function generatePassword(
  length = 12,
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(length));
  return [...bytes].map((b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

/** A WhatsApp share link for `text` (the user picks the chat). */
export const whatsappUrl = (text: string): string =>
  `https://wa.me/?text=${encodeURIComponent(text)}`;

/** The columns of a business entity's row in the matrix (ADR 0037). */
export const CRUD_COLUMNS = ['read', 'create', 'edit', 'delete'] as const;
export type CrudColumn = (typeof CRUD_COLUMNS)[number];

/**
 * An entity's keys as matrix cells: its read, create, edit and delete keys (a column is null where the key doesn't
 * exist), and the other keys of the entity. Null when the entity has no create, edit or delete key (a list then).
 */
export function crudRow(keys: readonly string[]): {
  cells: Record<CrudColumn, string | null>;
  extra: string[];
} | null {
  const isWrite = keys.some((key) => /\.(create|edit|delete)$/.test(key));
  if (!isWrite) return null;
  const cells = Object.fromEntries(
    CRUD_COLUMNS.map((verb) => [verb, keys.find((key) => key.endsWith(`.${verb}`)) ?? null]),
  ) as Record<CrudColumn, string | null>;
  const used = new Set(Object.values(cells));
  return { cells, extra: keys.filter((key) => !used.has(key)) };
}
