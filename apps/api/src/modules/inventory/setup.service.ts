import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type {
  CreateStockItemRequest,
  CreateWarehouseRequest,
  ListStockItemsQuery,
  ListWarehousesQuery,
  StockItem,
  StockUnit,
  UpdateStockItemRequest,
  UpdateWarehouseRequest,
  Warehouse,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import { CatalogService } from '../catalog';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { inventoryErrors, isUniqueViolation } from './inventory-errors';

const WAREHOUSE_SELECT = {
  id: true,
  locationId: true,
  name: true,
  sortOrder: true,
  suppliesStation: true,
  isTransit: true,
  isMain: true,
  suppliesLocationIds: true,
  archivedAt: true,
} as const;

export const ITEM_SELECT = {
  id: true,
  name: true,
  sku: true,
  unit: true,
  minQuantity: true,
  parentItemId: true,
  variantValues: true,
  salePrice: true,
  categoryId: true,
  brand: true,
  packCount: true,
  packSize: true,
  packUnit: true,
  archivedAt: true,
} as const;

type WarehouseRow = Omit<Warehouse, 'archivedAt'> & { archivedAt: Date | null };
export type ItemRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: StockUnit;
  minQuantity: { toFixed(digits: number): string } | null;
  parentItemId: string | null;
  variantValues: string[];
  salePrice: { toFixed(digits: number): string } | null;
  categoryId: string | null;
  brand: string | null;
  packCount: number | null;
  packSize: { toFixed(digits: number): string } | null;
  packUnit: StockUnit | null;
  archivedAt: Date | null;
};

/** The audit snapshot of an item: variant values joined in order (snapshots sort string arrays). */
export const itemSnapshot = (item: StockItem) =>
  snapshot('stock_item', { ...item, variantValues: item.variantValues.join(' / ') });

/**
 * Warehouses per location and organization-wide stock items (docs/modules/inventory.md). Archived,
 * never deleted. Warehouses are checked at their location: one the caller can't read doesn't exist
 * for them (404); one they can read but not manage is 403.
 */
@Injectable()
export class InventorySetupService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly catalog: CatalogService,
  ) {}

  async listWarehouses(query: ListWarehousesQuery): Promise<Warehouse[]> {
    const scope = await this.access.locationIdsFor('inventory.stock.read');
    // Limited to some warehouses (ADR 0057): those, and the transit one (the road between warehouses).
    const own = await this.access.warehouseIds();
    let locations: 'all' | string[] = scope;
    if (query.locationId) {
      locations = scope === 'all' || scope.includes(query.locationId) ? [query.locationId] : [];
    }
    if (locations !== 'all' && locations.length === 0) return [];
    const rows = await this.db.warehouse.findMany({
      where: {
        ...(locations === 'all' ? {} : { locationId: { in: locations } }),
        ...(own ? { OR: [{ id: { in: [...own] } }, { isTransit: true }] } : {}),
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      select: WAREHOUSE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(warehouseResponse);
  }

  async createWarehouse(body: CreateWarehouseRequest): Promise<Warehouse> {
    const { tenantId, userId } = this.tenantContext.require();
    const location = await this.db.location.findUnique({
      where: { id: body.locationId },
      select: { id: true },
    });
    if (!location) throw inventoryErrors.locationNotFound();
    await this.access.assert('inventory.warehouses.create', { locationId: body.locationId });
    const supplies = body.suppliesLocationIds ?? [];
    if (body.isMain || supplies.length > 0) await this.assertChoosesSupply();
    if (body.isMain && supplies.length > 0) throw inventoryErrors.suppliesInvalid();
    return this.unique(inventoryErrors.warehouseNameTaken, () =>
      this.db.$transaction(async (tx) => {
        if (body.isMain) await this.stepDownMain(tx, userId, null);
        if (supplies.length > 0) {
          await this.releaseSupplies(tx, userId, null, body.locationId, supplies);
        }
        const row = await tx.warehouse.create({
          data: {
            tenantId,
            locationId: body.locationId,
            name: body.name,
            sortOrder: body.sortOrder ?? 0,
            isMain: body.isMain ?? false,
            suppliesLocationIds: supplies,
          },
          select: WAREHOUSE_SELECT,
        });
        await this.audit.record(tx, {
          action: 'inventory.warehouse.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          after: snapshot('warehouse', row),
        });
        const response = warehouseResponse(row);
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async updateWarehouse(id: string, body: UpdateWarehouseRequest): Promise<Warehouse> {
    const { userId } = this.tenantContext.require();
    const found = await this.db.warehouse.findUnique({
      where: { id },
      select: { id: true, locationId: true },
    });
    if (!found || !(await this.access.canAtWarehouse('inventory.stock.read', found))) {
      throw inventoryErrors.warehouseNotFound();
    }
    await this.access.assertAtWarehouse('inventory.warehouses.edit', found);
    // Which branches it supplies (ADR 0053, 0067): chosen only by someone who edits warehouses everywhere.
    if (body.isMain !== undefined || body.suppliesLocationIds !== undefined) {
      await this.assertChoosesSupply();
    }
    if (body.isMain && (body.suppliesLocationIds?.length ?? 0) > 0) {
      throw inventoryErrors.suppliesInvalid();
    }
    return this.unique(inventoryErrors.warehouseNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const current = await tx.warehouse.findUniqueOrThrow({
          where: { id },
          select: WAREHOUSE_SELECT,
        });
        const data = {
          name: body.name ?? current.name,
          sortOrder: body.sortOrder ?? current.sortOrder,
          suppliesStation:
            body.suppliesStation === undefined ? current.suppliesStation : body.suppliesStation,
          archivedAt: archivedAt(current.archivedAt, body.archived),
          // Never the transit one; an archived warehouse stops being the main one.
          isMain: !current.isTransit && (body.isMain ?? current.isMain),
          // Main supplies every branch, so no list; supplying some branches makes it not the main one (ADR 0067).
          suppliesLocationIds: body.suppliesLocationIds ?? current.suppliesLocationIds,
        };
        if (body.suppliesLocationIds !== undefined && body.suppliesLocationIds.length > 0) {
          if (current.isTransit) throw inventoryErrors.suppliesInvalid();
          if (body.isMain === undefined) data.isMain = false;
        }
        if (data.isMain) data.suppliesLocationIds = [];
        // An archived warehouse supplies nobody: its branches go back to the main one.
        if (data.archivedAt !== null) {
          data.isMain = false;
          data.suppliesLocationIds = [];
        }
        // One active main warehouse per organization (warehouses_one_main_key): the previous one steps down.
        if (data.isMain && !current.isMain) await this.stepDownMain(tx, userId, id);
        // One supplier per branch: a branch ticked here leaves the warehouse that supplied it.
        if (data.suppliesLocationIds.length > 0) {
          const added = data.suppliesLocationIds.filter(
            (l) => !current.suppliesLocationIds.includes(l),
          );
          await this.releaseSupplies(
            tx,
            userId,
            id,
            current.locationId,
            data.suppliesLocationIds,
            added,
          );
        }
        // One active warehouse per location supplies each station (the partial unique index).
        if (data.suppliesStation && data.archivedAt === null) {
          const other = await tx.warehouse.findFirst({
            where: {
              locationId: current.locationId,
              suppliesStation: data.suppliesStation,
              archivedAt: null,
              id: { not: id },
            },
            select: { id: true },
          });
          if (other) throw inventoryErrors.stationTaken();
        }
        const before = snapshot('warehouse', current);
        if (
          JSON.stringify(before) === JSON.stringify(snapshot('warehouse', { ...current, ...data }))
        ) {
          return warehouseResponse(current);
        }
        const row = await tx.warehouse.update({ where: { id }, data, select: WAREHOUSE_SELECT });
        await this.audit.record(tx, {
          action: 'inventory.warehouse.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before,
          after: snapshot('warehouse', row),
        });
        return warehouseResponse(row);
      }),
    );
  }

  /** Choosing who supplies which branch (ADR 0053, 0067) needs warehouses edited everywhere. */
  private async assertChoosesSupply(): Promise<void> {
    if ((await this.access.locationIdsFor('inventory.warehouses.edit')) !== 'all') {
      throw inventoryErrors.mainWarehouseNotAllowed();
    }
  }

  /** The active main warehouse (other than `keep`) stops being it; audited. */
  private async stepDownMain(tx: TenantTransactionClient, userId: string, keep: string | null) {
    const previous = await tx.warehouse.findMany({
      where: { isMain: true, archivedAt: null, ...(keep ? { id: { not: keep } } : {}) },
      select: WAREHOUSE_SELECT,
    });
    for (const other of previous) {
      const row = await tx.warehouse.update({
        where: { id: other.id },
        data: { isMain: false },
        select: WAREHOUSE_SELECT,
      });
      await this.audit.record(tx, {
        action: 'inventory.warehouse.updated',
        actor: auditActor.user(userId),
        entityId: other.id,
        before: snapshot('warehouse', other),
        after: snapshot('warehouse', row),
      });
    }
  }

  /**
   * Before `self` (null: being created, at `ownLocationId`) supplies `locationIds`: they must be existing locations
   * other than its own, and each of `moved` (default: all) leaves the warehouse that supplied it, audited. Under an
   * organization-wide lock, so two edits can't give one branch two suppliers.
   */
  private async releaseSupplies(
    tx: TenantTransactionClient,
    userId: string,
    self: string | null,
    ownLocationId: string,
    locationIds: readonly string[],
    moved: readonly string[] = locationIds,
  ) {
    const { tenantId } = this.tenantContext.require();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`warehouse_supplies:${tenantId}`}, 0))`;
    if (locationIds.includes(ownLocationId)) throw inventoryErrors.suppliesInvalid();
    const found = await tx.location.count({ where: { id: { in: [...locationIds] } } });
    if (found !== locationIds.length) throw inventoryErrors.locationNotFound();
    if (moved.length === 0) return;
    const others = await tx.warehouse.findMany({
      where: {
        suppliesLocationIds: { hasSome: [...moved] },
        ...(self ? { id: { not: self } } : {}),
      },
      select: WAREHOUSE_SELECT,
    });
    for (const other of others) {
      const row = await tx.warehouse.update({
        where: { id: other.id },
        data: { suppliesLocationIds: other.suppliesLocationIds.filter((l) => !moved.includes(l)) },
        select: WAREHOUSE_SELECT,
      });
      await this.audit.record(tx, {
        action: 'inventory.warehouse.updated',
        actor: auditActor.user(userId),
        entityId: other.id,
        before: snapshot('warehouse', other),
        after: snapshot('warehouse', row),
      });
    }
  }

  async listItems(query: ListStockItemsQuery): Promise<StockItem[]> {
    const rows = await this.db.stockItem.findMany({
      where: query.includeArchived ? {} : { archivedAt: null },
      select: ITEM_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const prices = await this.seesPrices();
    return rows.map((row) => priced(itemResponse(row), prices));
  }

  /**
   * Whether the caller sees prices and values (ADR 0060): inventory.prices.read at any of their locations. A member's
   * location limits hold for all of their keys alike, so that is where they read stock too.
   */
  private async seesPrices(): Promise<boolean> {
    const at = await this.access.locationIdsFor('inventory.prices.read');
    return at === 'all' || at.length > 0;
  }

  async createItem(body: CreateStockItemRequest): Promise<StockItem> {
    const { tenantId, userId } = this.tenantContext.require();
    if (body.categoryId) await this.catalog.assertActiveCategory(body.categoryId);
    // A sale price only from someone who sees prices (ADR 0060).
    const prices = await this.seesPrices();
    return this.unique(inventoryErrors.itemNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const row = await tx.stockItem.create({
          data: {
            tenantId,
            name: body.name,
            sku: body.sku ?? null,
            unit: body.unit,
            minQuantity: body.minQuantity ?? null,
            salePrice: prices ? (body.salePrice ?? null) : null,
            categoryId: body.categoryId ?? null,
            brand: body.brand ?? null,
            packCount: body.packCount ?? null,
            packSize: body.packSize ?? null,
            packUnit: body.packUnit ?? null,
          },
          select: ITEM_SELECT,
        });
        const item = itemResponse(row);
        await this.audit.record(tx, {
          action: 'inventory.stock_item.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          after: itemSnapshot(item),
        });
        const response = priced(item, prices);
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async updateItem(id: string, body: UpdateStockItemRequest): Promise<StockItem> {
    const { userId } = this.tenantContext.require();
    if (body.categoryId) await this.catalog.assertActiveCategory(body.categoryId);
    // Without prices the sale price stays as it is, whatever is sent (ADR 0060).
    const prices = await this.seesPrices();
    return this.unique(inventoryErrors.itemNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const current = await tx.stockItem.findUnique({ where: { id }, select: ITEM_SELECT });
        if (!current) throw inventoryErrors.itemNotFound([id]);
        if (body.unit !== undefined && body.unit !== current.unit) {
          const moved = await tx.stockMovement.findFirst({
            where: { itemId: id },
            select: { id: true },
          });
          if (moved) throw inventoryErrors.unitLocked();
        }
        const before = itemResponse(current);
        const next: StockItem = {
          ...before,
          name: body.name ?? before.name,
          sku: body.sku === undefined ? before.sku : body.sku,
          unit: body.unit ?? before.unit,
          minQuantity:
            body.minQuantity === undefined
              ? before.minQuantity
              : body.minQuantity === null
                ? null
                : fixed3(body.minQuantity),
          salePrice:
            body.salePrice === undefined || !prices
              ? before.salePrice
              : body.salePrice === null
                ? null
                : new Decimal(body.salePrice).toFixed(2),
          categoryId: body.categoryId === undefined ? before.categoryId : body.categoryId,
          brand: body.brand === undefined ? before.brand : body.brand,
          packCount: body.packCount === undefined ? before.packCount : body.packCount,
          packSize:
            body.packSize === undefined
              ? before.packSize
              : body.packSize === null
                ? null
                : fixed3(body.packSize),
          packUnit: body.packUnit === undefined ? before.packUnit : body.packUnit,
          archivedAt: archivedAt(current.archivedAt, body.archived)?.toISOString() ?? null,
        };
        if (JSON.stringify(itemSnapshot(before)) === JSON.stringify(itemSnapshot(next))) {
          return priced(before, prices);
        }
        const row = await tx.stockItem.update({
          where: { id },
          data: {
            name: next.name,
            sku: next.sku,
            unit: next.unit,
            minQuantity: next.minQuantity,
            salePrice: next.salePrice,
            categoryId: next.categoryId,
            brand: next.brand,
            packCount: next.packCount,
            packSize: next.packSize,
            packUnit: next.packUnit,
            archivedAt: archivedAt(current.archivedAt, body.archived),
          },
          select: ITEM_SELECT,
        });
        const after = itemResponse(row);
        await this.audit.record(tx, {
          action: 'inventory.stock_item.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before: itemSnapshot(before),
          after: itemSnapshot(after),
        });
        return priced(after, prices);
      }),
    );
  }

  private async unique<T>(taken: () => Error, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw taken();
      throw error;
    }
  }
}

/** `archived`: true archives (keeping the first archive time), false restores, absent keeps. */
function archivedAt(current: Date | null, archived: boolean | undefined): Date | null {
  if (archived === undefined) return current;
  if (!archived) return null;
  return current ?? new Date();
}

/** A decimal string with exactly 3 decimals, as the column stores it. */
function fixed3(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(3, '0')}`;
}

function warehouseResponse(row: WarehouseRow): Warehouse {
  return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null };
}

/** An item as the caller may see it (ADR 0060): no sale price without inventory.prices.read. */
const priced = (item: StockItem, prices: boolean): StockItem =>
  prices ? item : { ...item, salePrice: null };

export function itemResponse(row: ItemRow): StockItem {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    minQuantity: row.minQuantity?.toFixed(3) ?? null,
    parentItemId: row.parentItemId,
    variantValues: row.variantValues,
    salePrice: row.salePrice?.toFixed(2) ?? null,
    categoryId: row.categoryId,
    brand: row.brand,
    packCount: row.packCount,
    packSize: row.packSize?.toFixed(3) ?? null,
    packUnit: row.packUnit,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
