import type { AuditEntityType } from '@durby/shared';

/**
 * The only fields that can ever reach `before`/`after` (ADR 0008 §5), per entity type. Never add
 * password or token hashes, tokens, links or email addresses: audit rows can't be updated or erased.
 */
export const AUDIT_SNAPSHOT_FIELDS = {
  organization: ['id', 'partnerId', 'name', 'planId'],
  role: ['id', 'systemKey', 'name', 'permissions'],
  membership: ['id', 'userId', 'roleId', 'allLocations', 'locationIds'],
  invitation: [
    'id',
    'roleId',
    'allLocations',
    'locationIds',
    'expiresAt',
    'acceptedAt',
    'acceptedByUserId',
    'revokedAt',
  ],
  session: ['organizationId', 'previousOrganizationId'],
  /** `limits`: canonical JSON string (sorted keys); snapshots hold flat values only. */
  feature_override: ['id', 'featureKey', 'enabled', 'limits'],
  /** `features`: sorted keys, `key:<canonical limits json>` where a plan sets limits. */
  plan: ['id', 'key', 'features'],
  /** `value`: canonical JSON string (sorted keys). Settings never hold secrets (ADR 0010). */
  setting_value: ['id', 'key', 'scopeType', 'brandId', 'locationId', 'value'],
  /** Label text is plain text, never a secret (ADR 0011). */
  label_override: ['id', 'locale', 'key', 'value'],
} as const satisfies Record<AuditEntityType, readonly string[]>;

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
