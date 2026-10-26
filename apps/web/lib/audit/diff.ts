import { isLabelKey, type LabelKey, type Translator } from '@durby/i18n';
import {
  AUDIT_SNAPSHOT_FIELDS,
  type AuditLogEntry,
  isPermissionKey,
  type LocationSummary,
  PERMISSIONS,
  type Role,
} from '@durby/shared';

/**
 * The before/after diff of an audit entry (docs/platform/web-shell.md → List): one row per
 * allow-listed field, in the allow-list's order, with readable values.
 */

export interface DiffRow {
  field: string;
  before: unknown;
  after: unknown;
  /** Present on one side only, or different. */
  changed: boolean;
  /** Which sides exist: a create has no before, a delete no after. */
  hasBefore: boolean;
  hasAfter: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The diff rows; `id` is left out (the entity id is in the details). */
export function diffRows(entry: Pick<AuditLogEntry, 'entityType' | 'before' | 'after'>): DiffRow[] {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const known = AUDIT_SNAPSHOT_FIELDS[entry.entityType] as readonly string[];
  const extra = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (f) => !known.includes(f),
  );
  return [...known, ...extra]
    .filter((field) => field !== 'id' && (field in before || field in after))
    .map((field) => ({
      field,
      before: before[field],
      after: after[field],
      changed: !(field in before && field in after && same(before[field], after[field])),
      hasBefore: entry.before !== null,
      hasAfter: entry.after !== null,
    }));
}

/** `platform.audit.fields.<camelCaseField>`, e.g. `allLocations`; `nextValue` stays as it is. */
export function fieldLabel(field: string): LabelKey | null {
  const key = `platform.audit.fields.${field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
  return isLabelKey(key) ? key : null;
}

export interface FormatContext {
  t: Translator;
  locale: string;
  timeZone: string;
  roles: readonly Role[] | null;
  locations: readonly LocationSummary[] | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A snapshot value as text: names for known ids, labels for keys, dates in the org's zone. */
export function formatValue(field: string, value: unknown, ctx: FormatContext): string {
  const { t } = ctx;
  if (value === null || value === undefined) return t('platform.auditPage.empty');
  if (typeof value === 'boolean')
    return t(value ? 'platform.auditPage.yes' : 'platform.auditPage.no');
  // Setting values and feature limits are stored as canonical JSON text: show a scalar as itself.
  if ((field === 'value' || field === 'limits') && typeof value === 'string') {
    const parsed = parseJson(value);
    if (parsed.ok && (typeof parsed.value !== 'object' || parsed.value === null)) {
      return formatValue('', parsed.value, ctx);
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return t('platform.auditPage.none');
    return value.map((item) => formatValue(singular(field), item, ctx)).join(', ');
  }
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number'
        ? String(value)
        : JSON.stringify(value);
  if (field === 'roleId') {
    const role = ctx.roles?.find((r) => r.id === text);
    if (role) return role.systemKey ? t(`platform.roles.${role.systemKey}`) : (role.name ?? text);
  }
  if (field === 'locationId') {
    const location = ctx.locations?.find((l) => l.id === text);
    if (location) return location.name;
  }
  if (field === 'systemKey' && isLabelKey(`platform.roles.${text}`)) {
    return t(`platform.roles.${text}` as LabelKey);
  }
  if (field === 'permission' && isPermissionKey(text)) {
    const label = PERMISSIONS[text].label;
    if (isLabelKey(label)) return t(label);
  }
  if (typeof value === 'string' && ISO.test(text)) {
    return new Intl.DateTimeFormat(ctx.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: ctx.timeZone,
    }).format(new Date(text));
  }
  return text;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The field name of one item of a list field (`locationIds` → `locationId`). */
function singular(field: string): string {
  if (field === 'permissions') return 'permission';
  return field.endsWith('Ids') ? field.slice(0, -1) : field;
}

/** Whether a value is an id (shown in monospace when no name is known). */
export const looksLikeId = (text: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
