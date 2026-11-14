import type { LabelKey } from '@durby/i18n';
import type { AuditLogEntry, LocationSummary, TeamMember } from '@durby/shared';
import { diffRows, fieldLabel } from './diff';

/**
 * How the audit log shows an entry in its table (docs/platform/web-shell.md → Audit log viewer): the record's
 * name, where it happened, a one-line detail, who did it, and CSV export. Snapshots are allow-listed (ADR 0008), so
 * everything here is already safe to show.
 */

type Translate = (key: LabelKey, params?: Record<string, string>) => string;
type Snapshot = Record<string, unknown> | null;

const fieldsOf = (entry: Pick<AuditLogEntry, 'before' | 'after'>): Snapshot =>
  entry.after ?? entry.before;

/** The record's name as people know it: its name, number, email or symbol; null when the snapshot has none. */
export function recordOf(entry: Pick<AuditLogEntry, 'before' | 'after'>): string | null {
  const fields = fieldsOf(entry);
  if (!fields) return null;
  for (const key of ['name', 'number', 'email', 'menuNumber', 'symbol']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** The location (branch) the record is at, by name; null for organization-wide records. */
export function whereOf(
  entry: Pick<AuditLogEntry, 'before' | 'after'>,
  locations: readonly LocationSummary[] | null,
): string | null {
  const id = entry.after?.locationId ?? entry.before?.locationId;
  if (typeof id !== 'string') return null;
  return locations?.find((l) => l.id === id)?.name ?? null;
}

const MAX_FIELDS = 6;

/** "Name, Unit, Price" from field keys, at most six, then "…". */
function fieldList(fields: readonly string[], t: Translate): string {
  const names = fields.map((field) => {
    const key = fieldLabel(field);
    return key ? t(key) : field;
  });
  return names.length > MAX_FIELDS
    ? `${names.slice(0, MAX_FIELDS).join(', ')}, …`
    : names.join(', ');
}

/** One line under the action: the fields set on a create, changed on an update; deletes say so. */
export function detailOf(
  entry: Pick<AuditLogEntry, 'entityType' | 'before' | 'after'>,
  t: Translate,
): string | null {
  if (entry.after === null) return t('platform.auditPage.detailDeleted');
  const rows = diffRows(entry).filter((row) => row.field !== 'id');
  if (entry.before === null) {
    const set = rows
      .filter((row) => row.after !== null && row.after !== '')
      .map((row) => row.field);
    return set.length > 0 ? t('platform.auditPage.detailSet', { fields: fieldList(set, t) }) : null;
  }
  const changed = rows.filter((row) => row.changed).map((row) => row.field);
  return changed.length > 0
    ? t('platform.auditPage.detailChanged', { fields: fieldList(changed, t) })
    : null;
}

export interface Who {
  /** The person's name, else their email; a system actor's label. */
  name: string;
  /** Shown under the name when it differs from it. */
  email: string | null;
  /** Their role in this organization (custom name or system role label), when the team can be read. */
  role: string | null;
  userId: string | null;
}

/** Who did it: name, email and role from the team list when readable, else the email the api gives. */
export function whoOf(
  entry: Pick<AuditLogEntry, 'actor'>,
  team: readonly TeamMember[] | null,
  t: Translate,
  systemLabel: (key: string) => string,
): Who {
  if (entry.actor.type === 'system') {
    return { name: systemLabel(entry.actor.key), email: null, role: null, userId: null };
  }
  const { userId } = entry.actor;
  const member = team?.find((m) => m.userId === userId);
  const email = member?.email ?? entry.actor.email;
  const role = member?.role
    ? (member.role.name ?? t(`platform.roles.${member.role.systemKey ?? 'staff'}` as LabelKey))
    : null;
  return {
    name: member?.name ?? email ?? t('platform.auditPage.unknownUser'),
    email: member?.name ? email : null,
    role,
    userId,
  };
}

/** Whether an entry matches the search text: record, person, email, role, detail, action and where. */
export function matchesSearch(texts: readonly (string | null)[], q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.toLocaleLowerCase();
  return texts.some((text) => text !== null && text.toLocaleLowerCase().includes(needle));
}

/**
 * One CSV cell: quoted, quotes doubled. Cells starting with = + - @ (or a tab/CR) get a leading apostrophe, so a
 * spreadsheet never runs them as formulas (CSV injection).
 */
export function csvCell(value: string | null): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Rows to CSV text (CRLF line ends, as spreadsheets expect). */
export function toCsv(rows: readonly (readonly (string | null)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
