import { AUDIT_SNAPSHOT_FIELDS, type AuditEntityType } from '@durby/shared';

/** The allow-list lives in packages/shared, so the web app can label every field it shows. */
export { AUDIT_SNAPSHOT_FIELDS };

type Field<T extends AuditEntityType> = (typeof AUDIT_SNAPSHOT_FIELDS)[T][number];

export type SnapshotValue = string | number | boolean | null | readonly string[];

/** A flat, allow-listed snapshot of one entity. Built only by snapshot(). */
export type Snapshot<T extends AuditEntityType> = Readonly<
  Partial<Record<Field<T>, SnapshotValue>>
> & {
  readonly __snapshot: T;
};

type SourceValue = SnapshotValue | Date | undefined;

/**
 * Picks the allow-listed fields of `source` and drops everything else. Dates become ISO strings,
 * string arrays are sorted (stable diffs). Nested objects are rejected so a relation (e.g. a user
 * with its password hash) can never slip in under an allowed name.
 */
export function snapshot<T extends AuditEntityType>(
  type: T,
  source: Readonly<Partial<Record<Field<T>, SourceValue>>>,
): Snapshot<T> {
  const out: Record<string, SnapshotValue> = {};
  const values = source as Readonly<Record<string, unknown>>;
  for (const field of AUDIT_SNAPSHOT_FIELDS[type] as readonly string[]) {
    if (!Object.hasOwn(values, field)) continue;
    const value = values[field];
    if (value === undefined) continue;
    out[field] = normalize(type, field, value);
  }
  return out as Snapshot<T>;
}

function normalize(type: string, field: string, value: unknown): SnapshotValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as string | number | boolean | null;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return [...value].sort();
  }
  throw new TypeError(`audit snapshot ${type}.${field} must be a scalar, a Date or a string array`);
}
