import {
  addDays,
  AUDIT_ACTION_KEYS,
  AUDIT_MODULES,
  AUDIT_ENTITY_TYPES,
  type AuditAction,
  type AuditEntityType,
  zonedDayBounds,
} from '@durby/shared';

/**
 * The audit log's filters and their URL form (docs/platform/web-shell.md → Filters):
 * `?action=&entityType=&actor=&from=YYYY-MM-DD&to=YYYY-MM-DD`. Dates are calendar days in the
 * organization's time zone; the api gets instants.
 */
export interface AuditFilters {
  action?: AuditAction;
  entityType?: AuditEntityType;
  /** A user id (actorUserId). */
  actor?: string;
  /** An action's module (`inventory`, `pos`, …). */
  module?: string;
  /** A location (branch) id: entries whose record is there. */
  location?: string;
  /** Search text, matched in the page against record, person, email and detail (not sent to the api). */
  q?: string;
  /** First day, inclusive. */
  from?: string;
  /** Last day, inclusive. */
  to?: string;
}

const SEARCH_MAX_LENGTH = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as `YYYY-MM-DD` (rejects 2026-02-30). */
export function isDay(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Filters from the URL; unknown or malformed values are dropped, never sent. */
export function filtersFromParams(params: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};
  const action = params.get('action');
  if (action && (AUDIT_ACTION_KEYS as readonly string[]).includes(action)) {
    filters.action = action as AuditAction;
  }
  const entityType = params.get('entityType');
  if (entityType && (AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    filters.entityType = entityType as AuditEntityType;
  }
  const actor = params.get('actor');
  if (actor && UUID.test(actor)) filters.actor = actor.toLowerCase();
  const moduleKey = params.get('module');
  if (moduleKey && AUDIT_MODULES.includes(moduleKey)) filters.module = moduleKey;
  const location = params.get('location');
  if (location && UUID.test(location)) filters.location = location.toLowerCase();
  const q = params.get('q')?.trim();
  if (q) filters.q = q.slice(0, SEARCH_MAX_LENGTH);
  const from = params.get('from');
  if (from && isDay(from)) filters.from = from;
  const to = params.get('to');
  if (to && isDay(to) && (!filters.from || to >= filters.from)) filters.to = to;
  return filters;
}

/** The URL query of `filters`, in a stable order; empty filters are left out. */
export function paramsFromFilters(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of [
    'action',
    'entityType',
    'actor',
    'module',
    'location',
    'q',
    'from',
    'to',
  ] as const) {
    const value = filters[name];
    if (value) params.set(name, value);
  }
  return params;
}

/** The instant a calendar day starts in `timeZone` (ISO), with that day's offset (DST-safe). */
export function dayStart(day: string, timeZone: string): string {
  return zonedDayBounds(day, timeZone).start.toISOString();
}

/** The day after `day` (`YYYY-MM-DD`). */
export function nextDay(day: string): string {
  return addDays(day, 1);
}

/** The api query for `filters` (from inclusive, to exclusive: the start of the day after). */
export function apiQuery(filters: AuditFilters, timeZone: string): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.action) query.set('action', filters.action);
  if (filters.entityType) query.set('entityType', filters.entityType);
  if (filters.actor) query.set('actorUserId', filters.actor);
  if (filters.module) query.set('module', filters.module);
  if (filters.location) query.set('locationId', filters.location);
  if (filters.from) query.set('from', dayStart(filters.from, timeZone));
  if (filters.to) query.set('to', dayStart(nextDay(filters.to), timeZone));
  return query;
}
