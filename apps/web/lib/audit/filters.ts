import {
  AUDIT_ACTION_KEYS,
  AUDIT_ENTITY_TYPES,
  type AuditAction,
  type AuditEntityType,
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
  /** First day, inclusive. */
  from?: string;
  /** Last day, inclusive. */
  to?: string;
}

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
  const from = params.get('from');
  if (from && isDay(from)) filters.from = from;
  const to = params.get('to');
  if (to && isDay(to) && (!filters.from || to >= filters.from)) filters.to = to;
  return filters;
}

/** The URL query of `filters`, in a stable order; empty filters are left out. */
export function paramsFromFilters(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of ['action', 'entityType', 'actor', 'from', 'to'] as const) {
    const value = filters[name];
    if (value) params.set(name, value);
  }
  return params;
}

/** Offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich). */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a calendar day starts in `timeZone` (ISO), with that day's offset (DST-safe). */
export function dayStart(day: string, timeZone: string): string {
  const m = DAY.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Two passes: the offset at the guess can differ from the offset at the result around a change.
  let instant = local - offsetMs(local, timeZone);
  instant = local - offsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

/** The day after `day` (`YYYY-MM-DD`). */
export function nextDay(day: string): string {
  const m = DAY.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1))
    .toISOString()
    .slice(0, 10);
}

/** The api query for `filters` (from inclusive, to exclusive: the start of the day after). */
export function apiQuery(filters: AuditFilters, timeZone: string): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.action) query.set('action', filters.action);
  if (filters.entityType) query.set('entityType', filters.entityType);
  if (filters.actor) query.set('actorUserId', filters.actor);
  if (filters.from) query.set('from', dayStart(filters.from, timeZone));
  if (filters.to) query.set('to', dayStart(nextDay(filters.to), timeZone));
  return query;
}
