import {
  canManageMember,
  FEATURES,
  isFeatureKey,
  type MatrixColumn,
  type MatrixPlacement,
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
    const placement: MatrixPlacement = PERMISSIONS[key].matrix;
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
