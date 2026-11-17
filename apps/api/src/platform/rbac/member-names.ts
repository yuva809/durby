import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey } from '@durby/shared';
import type { TenantDb } from '../tenancy';
import { holds, resolveAccess } from './access';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';

/**
 * Display names of the current organization's members, for modules that print who did something
 * (the waiter on a bill, ADR 0025). Modules keep user ids without a foreign key and may not read
 * memberships themselves. Reads in the caller's client and transaction (RLS: own tenant only) and
 * checks no permission: callers check their own keys first.
 */
@Injectable()
export class MemberNames {
  constructor(@Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry) {}

  /** userId → display name; users without a membership here or without a name are left out. */
  async forUsers(db: TenantDb, userIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const rows = await db.membership.findMany({
      where: { userId: { in: ids }, displayName: { not: null } },
      select: { userId: true, displayName: true },
    });
    return new Map(rows.map((r) => [r.userId, r.displayName!]));
  }

  /**
   * The active members who hold `key` at `locationId` (role, per-member grants and denies, location scope), with
   * their display name when they have one: e.g. who can drive for a warehouse (ADR 0045). Owners hold every key.
   */
  async holders(
    db: TenantDb,
    key: PermissionKey,
    locationId: string,
  ): Promise<{ userId: string; name: string | null }[]> {
    const rows = await db.membership.findMany({
      where: { deactivatedAt: null },
      select: {
        id: true,
        userId: true,
        displayName: true,
        allLocations: true,
        deactivatedAt: true,
        permissions: { select: { permissionKey: true, effect: true } },
        role: {
          select: {
            id: true,
            systemKey: true,
            name: true,
            permissions: { select: { permissionKey: true } },
          },
        },
        locations: { select: { locationId: true } },
      },
    });
    return rows
      .filter((row) => holds(resolveAccess(this.registry, row), this.registry, key, locationId))
      .map((row) => ({ userId: row.userId, name: row.displayName }));
  }

  /** Active members whose display name contains the query (the top bar search, ADR 0046); callers check platform.users.read. */
  async search(db: TenantDb, q: string, take: number): Promise<{ userId: string; name: string }[]> {
    const rows = await db.membership.findMany({
      where: { deactivatedAt: null, displayName: { contains: q, mode: 'insensitive' } },
      select: { userId: true, displayName: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take,
    });
    return rows.map((r) => ({ userId: r.userId, name: r.displayName! }));
  }
}
