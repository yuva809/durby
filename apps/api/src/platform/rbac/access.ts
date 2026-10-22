import { SYSTEM_ROLE_GRANTS, type SystemRole } from '@durby/shared';
import type { PermissionRegistry } from './permission-registry';

/** What the caller may do in the active organization, resolved from their membership. */
export interface ResolvedAccess {
  membershipId: string | null;
  roleId: string | null;
  systemRole: SystemRole | null;
  /** Custom roles only. */
  roleName: string | null;
  /** The role's registered keys, before location scope (used to compare roles when granting). */
  roleKeys: ReadonlySet<string>;
  /** The keys the caller holds: organization-scope keys only when allLocations. */
  permissions: ReadonlySet<string>;
  allLocations: boolean;
  /** The locations of a location-limited membership (empty when allLocations). */
  locationIds: ReadonlySet<string>;
}

export const NO_ACCESS: ResolvedAccess = Object.freeze({
  membershipId: null,
  roleId: null,
  systemRole: null,
  roleName: null,
  roleKeys: new Set<string>(),
  permissions: new Set<string>(),
  allLocations: false,
  locationIds: new Set<string>(),
});

/** The membership as loaded for resolution (see AccessService). */
export interface MembershipAccessRow {
  id: string;
  allLocations: boolean;
  role: {
    id: string;
    systemKey: SystemRole | null;
    name?: string | null;
    permissions: readonly { permissionKey: string }[];
  } | null;
  locations: readonly { locationId: string }[];
}

/**
 * The registered keys of a role. Owner: every key. Other system roles: their grants in code
 * (keys missing there are denied). Custom roles: their stored keys that are registered; stored
 * keys that are no longer registered are ignored (fail closed).
 */
export function roleKeysOf(
  registry: PermissionRegistry,
  systemKey: SystemRole | null,
  storedKeys: readonly string[],
): ReadonlySet<string> {
  const registered = Object.keys(registry);
  if (systemKey === 'owner') return new Set(registered);
  if (systemKey !== null) {
    const grants = SYSTEM_ROLE_GRANTS[systemKey] as Readonly<Record<string, string | undefined>>;
    return new Set(registered.filter((key) => grants[key] === 'grant'));
  }
  return new Set(storedKeys.filter((key) => Object.hasOwn(registry, key)));
}

/**
 * Resolves a membership row. No membership or no role → no permissions. A location-limited
 * membership keeps only location-scope keys; with no location rows it covers no locations.
 */
export function resolveAccess(
  registry: PermissionRegistry,
  row: MembershipAccessRow | null,
): ResolvedAccess {
  if (!row) return NO_ACCESS;
  const roleKeys = row.role
    ? roleKeysOf(
        registry,
        row.role.systemKey,
        row.role.permissions.map((p) => p.permissionKey),
      )
    : new Set<string>();
  const permissions = row.allLocations
    ? roleKeys
    : new Set([...roleKeys].filter((key) => registry[key]?.scope === 'location'));
  return {
    membershipId: row.id,
    roleId: row.role?.id ?? null,
    systemRole: row.role?.systemKey ?? null,
    roleName: row.role?.name ?? null,
    roleKeys,
    permissions,
    allLocations: row.allLocations,
    locationIds: new Set(row.allLocations ? [] : row.locations.map((l) => l.locationId)),
  };
}

/**
 * Whether `access` holds `key`, at `locationId` if given. Organization-scope keys ignore the
 * location. A location-scope key without a location counts only when it covers every location.
 */
export function holds(
  access: ResolvedAccess,
  registry: PermissionRegistry,
  key: string,
  locationId?: string,
): boolean {
  if (!access.permissions.has(key)) return false;
  if (registry[key]?.scope !== 'location' || access.allLocations) return true;
  return locationId !== undefined && access.locationIds.has(locationId);
}

/** Whether `access` holds `key` anywhere (all locations, or at least one). */
export function holdsAnywhere(access: ResolvedAccess, key: string): boolean {
  return access.permissions.has(key) && (access.allLocations || access.locationIds.size > 0);
}
