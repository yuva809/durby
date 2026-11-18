import { Inject, Injectable } from '@nestjs/common';
import { PERMISSION_KEYS, type SystemRole } from '@durby/shared';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
} from '../tenancy';
import { roleKeysOf } from './access';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';

/**
 * ADR 0051: the broad keys and the keys that now share their meaning. The migration
 * (`prisma/migrations/20261118150000_split_broad_permission_keys`) holds the same table; a test keeps them equal.
 * A stored row on the left gets a row with the same effect on each key on the right.
 */
export const PERMISSION_SPLIT: Readonly<Record<string, readonly string[]>> = {
  'platform.roles.manage': [
    'platform.roles.create',
    'platform.roles.edit',
    'platform.roles.delete',
  ],
  'platform.users.manage': ['platform.users.edit', 'platform.users.delete'],
  'orders.orders.edit': ['orders.orders.delete'],
  'orders.customers.edit': ['orders.customers.delete'],
};

/** Every custom role gets it: before ADR 0051 every member saw the organization, with no key. */
export const ORG_READ = 'platform.org.read';

type Effect = 'grant' | 'deny';
interface Override {
  permissionKey: string;
  effect: Effect;
}

/** The rows the migration adds for these stored keys (keys already stored are not added again). */
export function addedKeys(stored: readonly string[], customRole = false): string[] {
  const have = new Set(stored);
  const out = new Set<string>();
  for (const key of stored) for (const next of PERMISSION_SPLIT[key] ?? []) out.add(next);
  if (customRole) out.add(ORG_READ);
  return [...out].filter((key) => !have.has(key));
}

/** The override rows the migration adds: each split key with the effect of the row it comes from. */
export function addedOverrides(stored: readonly Override[]): Override[] {
  const have = new Set(stored.map((o) => o.permissionKey));
  const out = new Map<string, Effect>();
  for (const { permissionKey, effect } of stored) {
    for (const next of PERMISSION_SPLIT[permissionKey] ?? []) {
      if (!have.has(next) && !out.has(next)) out.set(next, effect);
    }
  }
  return [...out].map(([permissionKey, effect]) => ({ permissionKey, effect }));
}

/** What stored keys meant before ADR 0051, written in today's keys: a broad key stands for itself and its split. */
function meaningBefore(keys: readonly string[]): string[] {
  return [...new Set(keys.flatMap((key) => [key, ...(PERMISSION_SPLIT[key] ?? [])]))];
}

/** Role keys ∪ grants − denies over the registered keys, without aliases (the cleanup release's view). */
function effective(
  registry: PermissionRegistry,
  systemKey: SystemRole | null,
  roleKeys: readonly string[],
  overrides: readonly Override[],
): string[] {
  const keys = new Set(roleKeysOf(registry, systemKey, [...roleKeys]));
  if (systemKey !== 'owner') {
    for (const { permissionKey, effect } of overrides) {
      if (!Object.hasOwn(registry, permissionKey)) continue;
      if (effect === 'grant') keys.add(permissionKey);
      else keys.delete(permissionKey);
    }
  }
  return PERMISSION_KEYS.filter((key) => keys.has(key));
}

/**
 * Effective keys before the migration (stored keys read with their pre-ADR 0051 meaning, and the organization view
 * every member had) and after it (stored plus added rows, read without aliases). Equal means the migration is
 * lossless for this role or member, and stays so once the aliases are gone.
 */
export function splitEffect(
  registry: PermissionRegistry,
  systemKey: SystemRole | null,
  roleKeys: readonly string[],
  overrides: readonly Override[],
): { before: string[]; after: string[] } {
  const custom = systemKey === null;
  const beforeRole = [...meaningBefore(roleKeys), ORG_READ];
  const beforeOverrides = overrides.flatMap((o) =>
    meaningBefore([o.permissionKey]).map((permissionKey) => ({ permissionKey, effect: o.effect })),
  );
  const afterRole = [...roleKeys, ...addedKeys(roleKeys, custom)];
  const afterOverrides = [...overrides, ...addedOverrides(overrides)];
  return {
    before: effective(registry, systemKey, beforeRole, beforeOverrides),
    after: effective(registry, systemKey, afterRole, afterOverrides),
  };
}

export interface SplitReportLine {
  organizationId: string;
  kind: 'role' | 'membership' | 'invitation';
  id: string;
  /** Custom role name, or the role a member or invitation has (system key or name). */
  role: string;
  adds: string[];
  /** Effective keys before and after are the same (always true for invitations: checked when accepted). */
  unchanged: boolean;
  lost: string[];
  gained: string[];
}

/**
 * The dry run of the ADR 0051 migration: per organization, every custom role, member with overrides and open
 * invitation with overrides that gets rows, and whether its effective permissions stay the same. Reads only.
 * Prints ids and role names, never emails.
 */
@Injectable()
export class PermissionSplitReport {
  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platform: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry,
    private readonly tenantContext: TenantContext,
  ) {}

  async run(): Promise<SplitReportLine[]> {
    const orgs = await this.platform.organization.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const lines: SplitReportLine[] = [];
    for (const { id } of orgs) lines.push(...(await this.forOrganization(id)));
    return lines;
  }

  private forOrganization(organizationId: string): Promise<SplitReportLine[]> {
    return this.tenantContext.run(
      { tenantId: organizationId, userId: SYSTEM_USER_ID },
      async () => {
        const roles = await this.db.role.findMany({
          select: {
            id: true,
            systemKey: true,
            name: true,
            permissions: { select: { permissionKey: true } },
          },
          orderBy: { id: 'asc' },
        });
        const roleById = new Map(roles.map((r) => [r.id, r]));
        const roleName = (id: string | null) => {
          const role = id ? roleById.get(id) : undefined;
          return role ? (role.systemKey ?? role.name ?? role.id) : '(none)';
        };
        const keysOf = (id: string | null) =>
          (id ? roleById.get(id)?.permissions : undefined)?.map((p) => p.permissionKey) ?? [];
        const lines: SplitReportLine[] = [];
        const line = (
          kind: SplitReportLine['kind'],
          id: string,
          roleId: string | null,
          adds: string[],
          overrides: readonly Override[],
        ) => {
          const systemKey = (roleId ? roleById.get(roleId)?.systemKey : null) ?? null;
          const { before, after } = splitEffect(
            this.registry,
            systemKey,
            keysOf(roleId),
            overrides,
          );
          const lost = before.filter((key) => !after.includes(key));
          const gained = after.filter((key) => !before.includes(key));
          lines.push({
            organizationId,
            kind,
            id,
            role: roleName(roleId),
            adds,
            unchanged: lost.length === 0 && gained.length === 0,
            lost,
            gained,
          });
        };

        for (const role of roles.filter((r) => r.systemKey === null)) {
          const adds = addedKeys(
            role.permissions.map((p) => p.permissionKey),
            true,
          );
          if (adds.length > 0) line('role', role.id, role.id, adds, []);
        }
        const members = await this.db.membership.findMany({
          where: { permissions: { some: {} } },
          select: {
            id: true,
            roleId: true,
            permissions: { select: { permissionKey: true, effect: true } },
          },
          orderBy: { id: 'asc' },
        });
        for (const m of members) {
          const adds = addedOverrides(m.permissions);
          if (adds.length > 0) {
            line('membership', m.id, m.roleId, adds.map(describe), m.permissions);
          }
        }
        const invitations = await this.db.invitation.findMany({
          where: { permissions: { some: {} } },
          select: {
            id: true,
            roleId: true,
            permissions: { select: { permissionKey: true, effect: true } },
          },
          orderBy: { id: 'asc' },
        });
        for (const i of invitations) {
          const adds = addedOverrides(i.permissions);
          if (adds.length > 0) {
            line('invitation', i.id, i.roleId, adds.map(describe), i.permissions);
          }
        }
        return lines;
      },
    );
  }
}

const describe = (o: Override) => `${o.effect} ${o.permissionKey}`;

/** The context's user for the report's reads (no user acts). */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
