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
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { inventoryErrors, isUniqueViolation } from './inventory-errors';

const WAREHOUSE_SELECT = {
  id: true,
  locationId: true,
  name: true,
  sortOrder: true,
  suppliesStation: true,
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
  ) {}

  async listWarehouses(query: ListWarehousesQuery): Promise<Warehouse[]> {
    const scope = await this.access.locationIdsFor('inventory.stock.read');
    let locations: 'all' | string[] = scope;
    if (query.locationId) {
      locations = scope === 'all' || scope.includes(query.locationId) ? [query.locationId] : [];
    }
    if (locations !== 'all' && locations.length === 0) return [];
    const rows = await this.db.warehouse.findMany({
      where: {
        ...(locations === 'all' ? {} : { locationId: { in: locations } }),
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
    return this.unique(inventoryErrors.warehouseNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const row = await tx.warehouse.create({
          data: {
            tenantId,
            locationId: body.locationId,
            name: body.name,
            sortOrder: body.sortOrder ?? 0,
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
      select: { locationId: true },
    });
    if (
      !found ||
      !(await this.access.can('inventory.stock.read', { locationId: found.locationId }))
    ) {
      throw inventoryErrors.warehouseNotFound();
    }
    await this.access.assert('inventory.warehouses.edit', { locationId: found.locationId });
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
        };
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

  async listItems(query: ListStockItemsQuery): Promise<StockItem[]> {
    const rows = await this.db.stockItem.findMany({
      where: query.includeArchived ? {} : { archivedAt: null },
      select: ITEM_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(itemResponse);
  }

  async createItem(body: CreateStockItemRequest): Promise<StockItem> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.unique(inventoryErrors.itemNameTaken, () =>
      this.db.$transaction(async (tx) => {
        const row = await tx.stockItem.create({
          data: {
            tenantId,
            name: body.name,
            sku: body.sku ?? null,
            unit: body.unit,
            minQuantity: body.minQuantity ?? null,
            salePrice: body.salePrice ?? null,
          },
          select: ITEM_SELECT,
        });
        const response = itemResponse(row);
        await this.audit.record(tx, {
          action: 'inventory.stock_item.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          after: itemSnapshot(response),
        });
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async updateItem(id: string, body: UpdateStockItemRequest): Promise<StockItem> {
    const { userId } = this.tenantContext.require();
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
            body.salePrice === undefined
              ? before.salePrice
              : body.salePrice === null
                ? null
                : new Decimal(body.salePrice).toFixed(2),
          archivedAt: archivedAt(current.archivedAt, body.archived)?.toISOString() ?? null,
        };
        if (JSON.stringify(itemSnapshot(before)) === JSON.stringify(itemSnapshot(next))) {
          return before;
        }
        const row = await tx.stockItem.update({
          where: { id },
          data: {
            name: next.name,
            sku: next.sku,
            unit: next.unit,
            minQuantity: next.minQuantity,
            salePrice: next.salePrice,
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
        return after;
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
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
