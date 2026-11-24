import { Inject, Injectable } from '@nestjs/common';
import {
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionResponse,
  SEARCH_LIMIT_PER_TYPE,
  type SearchResult,
} from '@durby/shared';
import { EntitlementService } from '../../platform/config/entitlements';
import { AccessService, MemberNames } from '../../platform/rbac';
import { asTenantDb, TENANT_PRISMA, type TenantPrismaClient } from '../../platform/tenancy';
import { CatalogLookup } from '../catalog';
import { InventoryLookup } from '../inventory';
import { OrdersLookup } from '../orders';

/**
 * The top bar's search and "waiting for me" (docs/platform/web-shell.md → Search and notifications, ADR 0046): asks
 * each module the organization has for what the caller may see, and puts the answers together. Reads only.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly entitlements: EntitlementService,
    private readonly access: AccessService,
    private readonly members: MemberNames,
    private readonly catalog: CatalogLookup,
    private readonly inventory: InventoryLookup,
    private readonly orders: OrdersLookup,
  ) {}

  async search(q: string): Promise<SearchResult[]> {
    const [catalog, inventory, orders, users] = await Promise.all([
      this.entitlements.isEnabled('catalog'),
      this.entitlements.isEnabled('inventory'),
      this.entitlements.isEnabled('orders'),
      this.access.can('platform.users.read'),
    ]);
    const branches = this.searchBranches(q);
    const parts = await Promise.all([
      inventory ? this.inventory.searchItems(q) : [],
      inventory ? this.inventory.searchWarehouses(q) : [],
      inventory ? this.inventory.searchDocuments(q) : [],
      branches,
      catalog ? this.catalog.searchProducts(q) : [],
      orders ? this.orders.search(q) : [],
      users
        ? this.members.search(asTenantDb(this.db), q, SEARCH_LIMIT_PER_TYPE).then((rows) =>
            rows.map((m): SearchResult => ({
              type: 'member',
              id: m.userId,
              title: m.name,
              subtitle: null,
            })),
          )
        : [],
    ]);
    return parts.flat();
  }

  /** Branches by name, at the caller's locations; warehouse places (ADR 0068) are not branches. */
  private async searchBranches(q: string): Promise<SearchResult[]> {
    const scope = await this.access.locationIdsFor('platform.settings.read');
    if (scope !== 'all' && scope.length === 0) return [];
    const rows = await asTenantDb(this.db).location.findMany({
      where: {
        archivedAt: null,
        isWarehouseSite: false,
        name: { contains: q, mode: 'insensitive' },
        ...(scope === 'all' ? {} : { id: { in: scope } }),
      },
      select: { id: true, name: true, address: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: SEARCH_LIMIT_PER_TYPE,
    });
    return rows.map((l) => ({
      type: 'branch',
      id: l.id,
      title: l.name,
      subtitle: l.address ?? null,
    }));
  }

  async attention(): Promise<AttentionResponse> {
    const [inventory, orders] = await Promise.all([
      this.entitlements.isEnabled('inventory'),
      this.entitlements.isEnabled('orders'),
    ]);
    const items: AttentionItem[] = [...(orders ? await this.orders.attention() : [])];
    if (inventory) {
      const low = await this.inventory.lowStockCount();
      if (low > 0) items.push({ kind: 'low_stock', count: low });
    }
    items.sort((a, b) => ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind));
    return { data: items, total: items.reduce((sum, i) => sum + i.count, 0) };
  }
}
