import { z } from 'zod';
import {
  configEntitlementsChangedV1,
  configLabelsChangedV1,
  configNumberSeriesChangedV1,
  configSettingsChangedV1,
} from './config';
import { posOrderClosedV1 } from './pos';
import {
  reservationsReservationCreatedV1,
  reservationsReservationStatusChangedV1,
  reservationsReservationUpdatedV1,
} from './reservations';

/**
 * Outbox event registry (docs/platform/outbox.md, ADR 0013 §2).
 *
 * Adding an event: a `module.entity.past_tense` type, `current: 1` and a strict schema under
 * `versions[1]`. Payloads carry ids, keys and enums only: no personal data, secrets or free text
 * (they pass through Redis and are retained). A change old handlers can't read is a new version;
 * keep the old one registered while its events may still be pending. A test fails on bad types,
 * gaps in versions, non-strict schemas or field names that suggest personal data or secrets.
 */
export interface EventDefinition {
  /** The version the api writes. */
  current: number;
  /** Every version that may still be pending or queued, 1 … current. */
  versions: Readonly<Record<number, z.ZodObject>>;
}

export const EVENTS = {
  'config.settings.changed': { current: 1, versions: { 1: configSettingsChangedV1 } },
  'config.labels.changed': { current: 1, versions: { 1: configLabelsChangedV1 } },
  'config.number_series.changed': { current: 1, versions: { 1: configNumberSeriesChangedV1 } },
  'config.entitlements.changed': { current: 1, versions: { 1: configEntitlementsChangedV1 } },
  'pos.order.closed': { current: 1, versions: { 1: posOrderClosedV1 } },
  'reservations.reservation.created': {
    current: 1,
    versions: { 1: reservationsReservationCreatedV1 },
  },
  'reservations.reservation.updated': {
    current: 1,
    versions: { 1: reservationsReservationUpdatedV1 },
  },
  'reservations.reservation.status_changed': {
    current: 1,
    versions: { 1: reservationsReservationStatusChangedV1 },
  },
} as const satisfies Record<string, EventDefinition>;

export type EventType = keyof typeof EVENTS;

export const EVENT_TYPES = Object.keys(EVENTS) as readonly EventType[];

type Events = typeof EVENTS;

/** Versions registered for a type. */
export type EventVersion<T extends EventType> = keyof Events[T]['versions'] & number;

/** Payload of a type at a version (default: the version the api writes). */
export type EventPayload<
  T extends EventType,
  V extends EventVersion<T> = Events[T]['current'] & EventVersion<T>,
> = z.infer<Events[T]['versions'][V] & z.ZodType>;

/** What a writer passes to OutboxService.add: always the current version. */
export type NewEvent = { [T in EventType]: { type: T; payload: EventPayload<T> } }[EventType];

/** Same shape as the `outbox_events_type_check` constraint. */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

/** Handler names (`module.camelCaseName`); same shape as the `processed_events_handler_check`. */
export const EVENT_HANDLER_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Largest payload the table accepts (`octet_length(payload::text)`, outbox_events_shape_check). */
export const EVENT_PAYLOAD_MAX_BYTES = 8192;

/** Words in field names that suggest personal data or secrets; payloads carry ids, keys and enums only. */
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
  'email',
  'name',
  'phone',
  'mobile',
  'address',
  'street',
  'birth',
  'iban',
  'tax',
  'ip',
  'token',
  'secret',
  'password',
  'hash',
]);

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(EVENTS, value);
}

/** Whether `version` is registered for `type`. */
export function isEventVersion(type: EventType, version: number): boolean {
  return Object.prototype.hasOwnProperty.call(EVENTS[type].versions, version);
}

/** The schema of a registered type and version, or undefined. */
export function eventSchema(type: string, version: number): z.ZodObject | undefined {
  if (!isEventType(type) || !isEventVersion(type, version)) return undefined;
  return (EVENTS[type].versions as Readonly<Record<number, z.ZodObject>>)[version];
}

/**
 * Problems with a registry: bad types, versions not exactly 1 … current, non-strict schemas,
 * forbidden field names (also nested). Empty for EVENTS (tested); takes any registry so the
 * checks are tested too.
 */
export function eventRegistryProblems(
  registry: Readonly<Record<string, EventDefinition>>,
): string[] {
  const problems: string[] = [];
  for (const [type, def] of Object.entries(registry)) {
    if (!EVENT_TYPE_PATTERN.test(type))
      problems.push(`${type}: type must be module.entity.past_tense`);
    if (!Number.isInteger(def.current) || def.current < 1) {
      problems.push(`${type}: current must be a positive integer`);
    }
    const versions = Object.keys(def.versions)
      .map(Number)
      .sort((a, b) => a - b);
    const expected = Array.from({ length: Math.max(def.current, 0) }, (_, i) => i + 1);
    if (versions.join() !== expected.join()) {
      problems.push(`${type}: versions must be exactly 1 … ${def.current}`);
    }
    for (const [version, schema] of Object.entries(def.versions)) {
      if (!isStrict(schema)) problems.push(`${type} v${version}: schema must be strict`);
      for (const field of fieldNames(schema)) {
        if (wordsOf(field).some((word) => FORBIDDEN_WORDS.has(word))) {
          problems.push(`${type} v${version}: field "${field}" suggests personal data or secrets`);
        }
      }
    }
  }
  return problems;
}

/** `customerEmail` → ['customer', 'email']; `ip_address` → ['ip', 'address']. */
function wordsOf(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((word) => word.toLowerCase());
}

/**
 * A strict object rejects unknown keys, so payloads can't carry free-form fields. Read from the
 * definition: probing with a parse would pass any schema with a required field.
 */
function isStrict(schema: z.ZodObject): boolean {
  return schema.def.catchall instanceof z.ZodNever;
}

/** Field names of an object schema, including nested objects and arrays of objects. */
function fieldNames(schema: z.ZodType): string[] {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject) {
    return Object.entries(inner.shape as Record<string, z.ZodType>).flatMap(([name, field]) => [
      name,
      ...fieldNames(field),
    ]);
  }
  if (inner instanceof z.ZodArray) return fieldNames(inner.element as z.ZodType);
  return [];
}

function unwrap(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrap(schema.unwrap() as z.ZodType);
  }
  return schema;
}
