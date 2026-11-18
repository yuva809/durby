import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SEARCH_LIMIT_PER_TYPE, type SearchResult } from '@durby/shared';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../../platform/tenancy';

/**
 * Inventory's part of the top bar (ADR 0046): stock items by name or SKU for the search, and how many items are at or
 * below their reorder level in the warehouses the caller can read (never In transit).
 */
@Injectable()
export class InventoryLookup {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
  ) {}

  async searchItems(q: string): Promise<SearchResult[]> {
    const scope = await this.access.locationIdsFor('inventory.stock.read');
    if (scope !== 'all' && scope.length === 0) return [];
    const rows = await this.db.stockItem.findMany({
      where: {
        archivedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, sku: true, unit: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: SEARCH_LIMIT_PER_TYPE,
    });
    return rows.map((i) => ({
      type: 'stock_item',
      id: i.id,
      title: i.name,
      subtitle: i.sku ?? null,
    }));
  }

  /** Item-and-warehouse pairs at or below the item's reorder level. */
  async lowStockCount(): Promise<number> {
    const scope = await this.access.locationIdsFor('inventory.stock.read');
    if (scope !== 'all' && scope.length === 0) return 0;
    const own = await this.access.warehouseIds();
    const levels = await this.db.stockLevel.findMany({
      where: {
        item: { archivedAt: null, minQuantity: { not: null } },
        warehouse: {
          archivedAt: null,
          isTransit: false,
          ...(scope === 'all' ? {} : { locationId: { in: scope } }),
          // Limited to some warehouses (ADR 0057): those only.
          ...(own ? { id: { in: [...own] } } : {}),
        },
      },
      select: { quantity: true, item: { select: { minQuantity: true } } },
    });
    return levels.filter((l) =>
      new Decimal(l.quantity.toFixed(3)).lte(l.item.minQuantity!.toFixed(3)),
    ).length;
  }
}
