import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey } from '@durby/shared';
import { ClsService } from 'nestjs-cls';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import {
  holds,
  holdsAnywhere,
  holdsAtWarehouse,
  type ResolvedAccess,
  resolveAccess,
} from './access';
import { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';
import { rbacErrors } from './rbac-errors';

const CLS_KEY = 'durby:access';

interface Cached {
  tenantId: string;
  userId: string;
  access: Promise<ResolvedAccess>;
}

/**
 * The caller's permissions in the active organization (docs/platform/rbac.md → Resolving
 * access). Loaded from the database once per request (cached in the request's CLS scope), never
 * from the token, so role changes apply to the next request. Needs a tenant context.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly cls: ClsService,
    private readonly tenantContext: TenantContext,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(PERMISSION_REGISTRY) private readonly registry: PermissionRegistry,
  ) {}

  /**
   * The resolved access of the current user in the current tenant. Pass `tx` to load it inside the
   * caller's transaction (the guard loads it together with the entitlements): no second connection.
   */
  current(tx?: TenantTransactionClient): Promise<ResolvedAccess> {
    const { tenantId, userId } = this.tenantContext.require();
    const active = this.cls.isActive();
    const cached = active ? this.cls.get<Cached | undefined>(CLS_KEY) : undefined;
    if (cached && cached.tenantId === tenantId && cached.userId === userId) return cached.access;
    const access = this.load(tenantId, userId, tx);
    if (active) this.cls.set<Cached>(CLS_KEY, { tenantId, userId, access });
    return access;
  }

  /** Drops the cached access of this request (after the caller's own membership changed). */
  forget(): void {
    if (this.cls.isActive()) this.cls.set(CLS_KEY, undefined);
  }

  /** `key` at `locationId`; organization-scope keys ignore the location. */
  async can(key: PermissionKey, opts: { locationId?: string } = {}): Promise<boolean> {
    return holds(await this.current(), this.registry, key, opts.locationId);
  }

  /** Throws 403 rbac.permission_denied unless `can(key, opts)`. */
  async assert(key: PermissionKey, opts: { locationId?: string } = {}): Promise<void> {
    if (!(await this.can(key, opts))) throw rbacErrors.permissionDenied(key);
  }

  /**
   * `key` for work in a warehouse (ADR 0057): at the warehouse's location, and the warehouse among the caller's when
   * they are limited to some. Use it wherever stock moves or is shown per warehouse.
   */
  async canAtWarehouse(
    key: PermissionKey,
    warehouse: { id: string; locationId: string },
  ): Promise<boolean> {
    return holdsAtWarehouse(await this.current(), this.registry, key, warehouse);
  }

  /** Throws 403 rbac.permission_denied unless `canAtWarehouse(key, warehouse)`. */
  async assertAtWarehouse(
    key: PermissionKey,
    warehouse: { id: string; locationId: string },
  ): Promise<void> {
    if (!(await this.canAtWarehouse(key, warehouse))) throw rbacErrors.permissionDenied(key);
  }

  /** The caller's warehouses (ADR 0057), or null: every warehouse at their locations. For filtering queries. */
  async warehouseIds(): Promise<ReadonlySet<string> | null> {
    return (await this.current()).warehouseIds;
  }

  /** `'all'`, or the locations the caller holds `key` for (empty: none). For filtering queries. */
  async locationIdsFor(key: PermissionKey): Promise<'all' | string[]> {
    const access = await this.current();
    if (!access.permissions.has(key)) return [];
    if (access.allLocations || this.registry[key]?.scope !== 'location') return 'all';
    return [...access.locationIds];
  }

  /** Used by the guard: the key for at least one location. Takes unregistered keys (false). */
  async holdsAnywhere(key: string): Promise<boolean> {
    return holdsAnywhere(await this.current(), key);
  }

  private async load(
    tenantId: string,
    userId: string,
    tx?: TenantTransactionClient,
  ): Promise<ResolvedAccess> {
    const row = await asTenantDb(tx ?? this.db).membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: {
        id: true,
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
        warehouseIds: true,
      },
    });
    return resolveAccess(this.registry, row);
  }
}
