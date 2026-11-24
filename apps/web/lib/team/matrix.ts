import {
  canManageMember,
  FEATURES,
  isFeatureKey,
  type MatrixColumn,
  type PermissionDefinition,
  PERMISSION_KEYS,
  PERMISSIONS,
  type PermissionKey,
  type TeamMember,
} from '@durby/shared';
import { isLabelKey, type LabelKey } from '@durby/i18n';
import type { UsersAccess } from '../users/access';

/**
 * Manage Staff in the browser (docs/platform/rbac.md → Manage Staff, ADR 0023): the permission
 * matrix and what the signed-in user may do. Hints only: the api applies the same rules.
 */

/** A key's module: its first segment (`pos.orders.take` → `pos`). */
export const moduleOf = (key: string): string => key.split('.')[0] ?? '';

/** A cell of the matrix: the key and, where the box allows more than its column says, the note label (ADR 0050). */
export interface MatrixCell {
  key: PermissionKey;
  note: LabelKey | null;
}

/** A row: its name and one cell per column (null where no key exists: never invent one). */
export interface MatrixRow {
  row: string;
  label: LabelKey;
  cells: Record<MatrixColumn, MatrixCell | null>;
  keys: PermissionKey[];
}

/** A section: one module (platform first), its name and rows. */
export interface MatrixSection {
  module: string;
  label: LabelKey;
  rows: MatrixRow[];
  keys: PermissionKey[];
}

const FALLBACK: LabelKey = 'platform.rolesPage.otherArea';
const labelOr = (key: string | undefined): LabelKey => (key && isLabelKey(key) ? key : FALLBACK);

/** A section's name: "Administration" for platform keys, otherwise the module's feature name. */
export function sectionLabel(module: string): LabelKey {
  if (module === 'platform') return 'platform.team.dialog.section.platform';
  return labelOr(isFeatureKey(module) ? FEATURES[module].label : undefined);
}

/** A row's name: `<module>.permissionRows.<row>`. */
export function rowLabel(row: string): LabelKey {
  const [module = '', name = ''] = row.split('.');
  return labelOr(`${module}.permissionRows.${name}`);
}

/**
 * The Manage Staff matrix (ADR 0050): sections → rows → View/Create/Edit/Delete cells, from the registry's matrix
 * placements in registry order. Platform keys always show; a module's only when its feature is enabled for the
 * organization. `hiddenModules` lists the switched-off ones (their name labels).
 */
export function permissionMatrix(activeFeatures: readonly string[]): {
  sections: MatrixSection[];
  hiddenModules: LabelKey[];
} {
  const enabled = new Set(activeFeatures);
  const shown = (module: string) =>
    module === 'platform' || !isFeatureKey(module) || enabled.has(module);
  const sections: MatrixSection[] = [];
  for (const key of PERMISSION_KEYS) {
    const owner = moduleOf(key);
    if (!shown(owner)) continue;
    const { matrix: placement, needs }: PermissionDefinition = PERMISSIONS[key];
    if (needs && !enabled.has(needs)) continue;
    const { row, column, note } = placement;
    let section = sections.find((s) => s.module === owner);
    if (!section) {
      section = { module: owner, label: sectionLabel(owner), rows: [], keys: [] };
      sections.push(section);
    }
    let line = section.rows.find((r) => r.row === row);
    if (!line) {
      line = {
        row,
        label: rowLabel(row),
        cells: { read: null, create: null, edit: null, delete: null },
        keys: [],
      };
      section.rows.push(line);
    }
    line.cells[column] = { key, note: note && isLabelKey(note) ? note : null };
    line.keys.push(key);
    section.keys.push(key);
  }
  const modules = [...new Set(PERMISSION_KEYS.map(moduleOf))];
  return {
    sections,
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
  /** Edit: `platform.users.edit` and the member's keys ⊆ yours. */
  canEdit: boolean;
  /** Deactivate, reactivate, remove: `platform.users.delete` and the member's keys ⊆ yours (ADR 0051). */
  canRemove: boolean;
}

/** The row's actions: never on yourself; members compared by their effective keys. */
export function teamRowActions(access: UsersAccess, member: TeamMember): TeamRowActions {
  const self = member.userId === access.actor.userId;
  if (self || !(access.canEditUsers || access.canRemoveUsers)) {
    return { self, canEdit: false, canRemove: false };
  }
  const verdict = canManageMember(access.actor, {
    userId: member.userId,
    role: member.role
      ? { systemKey: member.role.systemKey, keys: new Set(member.permissions) }
      : null,
  });
  const ok = verdict === 'ok';
  return { self, canEdit: ok && access.canEditUsers, canRemove: ok && access.canRemoveUsers };
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

/*
 * "Grant View first" (ADR 0050, follow-up 2026-11-18): on a row with a View box, Create, Edit and Delete can only be
 * ticked while View is. Unticking View clears the row's other actions (the ones you may change). Rows without a View
 * box don't change. A screen rule only: the api checks each key on its own, and data saved before stays as it is (an
 * action already ticked without View can be unticked, never ticked again).
 */

/** Each Create/Edit/Delete key of a row that has a View box → that View key. */
const VIEW_OF: ReadonlyMap<string, PermissionKey> = (() => {
  const views = new Map<string, PermissionKey>();
  for (const key of PERMISSION_KEYS) {
    const { row, column } = PERMISSIONS[key].matrix;
    if (column === 'read') views.set(row, key);
  }
  const out = new Map<string, PermissionKey>();
  for (const key of PERMISSION_KEYS) {
    const { row, column } = PERMISSIONS[key].matrix;
    const view = views.get(row);
    if (column !== 'read' && view) out.set(key, view);
  }
  return out;
})();

/** View key → the Create/Edit/Delete keys it gates. */
const GATED_BY: ReadonlyMap<string, readonly PermissionKey[]> = (() => {
  const out = new Map<string, PermissionKey[]>();
  for (const [key, view] of VIEW_OF)
    out.set(view, [...(out.get(view) ?? []), key as PermissionKey]);
  return out;
})();

/** The View key that must be ticked before `key`, or null (a View key itself, or a row without View). */
export const viewKeyFor = (key: string): PermissionKey | null => VIEW_OF.get(key) ?? null;

/** Whether `key`'s box can't be ticked now: unticked, and its row's View isn't ticked. */
export function blockedByView(selected: ReadonlySet<string>, key: string): boolean {
  const view = viewKeyFor(key);
  return view !== null && !selected.has(view) && !selected.has(key);
}

/**
 * One box ticked or unticked. Ticking an action whose View isn't ticked does nothing; unticking a View also unticks
 * its row's actions that `may` change (locked ones stay).
 */
export function tickOne(
  selected: ReadonlySet<string>,
  key: string,
  on: boolean,
  may: (key: string) => boolean,
): Set<string> {
  const next = new Set(selected);
  if (on) {
    if (!blockedByView(selected, key)) next.add(key);
    return next;
  }
  next.delete(key);
  for (const action of GATED_BY.get(key) ?? []) if (may(action)) next.delete(action);
  return next;
}

/**
 * Many boxes at once (a row, a section, Select all, Clear): only the keys `may` change. On: View boxes first, then
 * each action only if its View ends up ticked. Off: the keys, plus the actions of every View unticked.
 */
export function tickMany(
  selected: ReadonlySet<string>,
  keys: Iterable<string>,
  on: boolean,
  may: (key: string) => boolean,
): Set<string> {
  const mine = [...keys].filter(may);
  const next = new Set(selected);
  if (on) {
    for (const key of mine) if (viewKeyFor(key) === null) next.add(key);
    for (const key of mine) {
      const view = viewKeyFor(key);
      if (view !== null && next.has(view)) next.add(key);
    }
    return next;
  }
  for (const key of mine) next.delete(key);
  for (const key of mine) {
    for (const action of GATED_BY.get(key) ?? []) if (may(action)) next.delete(action);
  }
  return next;
}
