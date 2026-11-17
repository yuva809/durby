import { Inject, Injectable } from '@nestjs/common';
import {
  type AttentionItem,
  type PermissionKey,
  SEARCH_LIMIT_PER_TYPE,
  type SearchResult,
} from '@durby/shared';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';

/**
 * The orders module's part of the top bar (ADR 0046): customers, sales orders and stock requests for the search, and
 * the "waiting for me" counts of sales orders and branch requests. Each answer is limited by the caller's keys and
 * locations, as the module's own lists are.
 */
@Injectable()
export class OrdersLookup {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
  ) {}

  /** `{ field: { in: scope } }`, `{}` for all locations, null when the key is held nowhere. */
  private async at(key: PermissionKey, field: string): Promise<object | null> {
    const scope = await this.access.locationIdsFor(key);
    if (scope === 'all') return {};
    return scope.length === 0 ? null : { [field]: { in: scope } };
  }

  async search(q: string): Promise<SearchResult[]> {
    const [customers, orders, requests] = await Promise.all([
      this.searchCustomers(q),
      this.searchOrders(q),
      this.searchRequests(q),
    ]);
    return [...customers, ...orders, ...requests];
  }

  private async searchCustomers(q: string): Promise<SearchResult[]> {
    if ((await this.at('orders.customers.read', 'locationId')) === null) return [];
    const rows = await this.db.orderCustomer.findMany({
      where: {
        archivedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { code: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, code: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: SEARCH_LIMIT_PER_TYPE,
    });
    return rows.map((c) => ({ type: 'customer', id: c.id, title: c.name, subtitle: c.code }));
  }

  private async searchOrders(q: string): Promise<SearchResult[]> {
    const where = await this.at('orders.orders.read', 'locationId');
    if (where === null) return [];
    const rows = await this.db.salesOrder.findMany({
      where: {
        ...where,
        OR: [
          { number: { contains: q, mode: 'insensitive' } },
          { customer: { name: { contains: q, mode: 'insensitive' } } },
        ],
      },
      select: { id: true, number: true, customer: { select: { name: true } } },
      orderBy: { id: 'desc' },
      take: SEARCH_LIMIT_PER_TYPE,
    });
    return rows.map((o) => ({
      type: 'sales_order',
      id: o.id,
      title: o.number,
      subtitle: o.customer.name,
    }));
  }

  /** Requests the caller may see (as StockRequestsService.list), by request or transfer number. */
  private async searchRequests(q: string): Promise<SearchResult[]> {
    const { userId } = this.tenantContext.require();
    let visible: object;
    if (await this.access.can('orders.requests.approve')) {
      visible = {};
    } else {
      const read = await this.access.locationIdsFor('orders.requests.read');
      const assign = await this.access.locationIdsFor('orders.delivery.assign');
      if (read === 'all' || assign === 'all') {
        visible = {};
      } else {
        visible = {
          OR: [
            { locationId: { in: read } },
            { fromLocationId: { in: [...new Set([...read, ...assign])] } },
            { driverUserId: userId },
          ],
        };
      }
    }
    const rows = await this.db.stockRequest.findMany({
      where: {
        AND: [
          visible,
          {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { transferNumber: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true,
        number: true,
        transferNumber: true,
        location: { select: { name: true } },
      },
      orderBy: { id: 'desc' },
      take: SEARCH_LIMIT_PER_TYPE,
    });
    return rows.map((r) => ({
      type: 'stock_request',
      id: r.id,
      title: r.transferNumber ?? r.number,
      subtitle: r.transferNumber ? `${r.number} · ${r.location.name}` : r.location.name,
    }));
  }

  /** What waits for the caller in orders and branch requests; kinds with nothing are left out. */
  async attention(): Promise<AttentionItem[]> {
    const { userId } = this.tenantContext.require();
    const count = async (
      kind: AttentionItem['kind'],
      run: () => Promise<number> | null,
    ): Promise<AttentionItem | null> => {
      const pending = run();
      if (pending === null) return null;
      const n = await pending;
      return n > 0 ? { kind, count: n } : null;
    };
    const [approve, picking, receive, deliveryUse, edit] = await Promise.all([
      this.access.can('orders.requests.approve'),
      this.at('orders.picking.use', 'fromLocationId'),
      this.at('orders.requests.receive', 'locationId'),
      this.at('orders.delivery.use', 'locationId'),
      this.at('orders.orders.edit', 'locationId'),
    ]);
    const salesPicking = await this.at('orders.picking.use', 'locationId');
    const items = await Promise.all([
      count('requests_to_approve', () =>
        approve ? this.db.stockRequest.count({ where: { status: 'submitted' } }) : null,
      ),
      count('transfers_to_pick', () =>
        picking
          ? this.db.stockRequest.count({
              where: { ...picking, status: { in: ['approved', 'picking'] } },
            })
          : null,
      ),
      count('my_deliveries', () =>
        deliveryUse
          ? this.db.stockRequest.count({
              where: { driverUserId: userId, status: { in: ['packed', 'in_transit'] } },
            })
          : null,
      ),
      count('goods_to_receive', () =>
        receive
          ? this.db.stockRequest.count({
              where: { ...receive, status: { in: ['packed', 'in_transit', 'delivered'] } },
            })
          : null,
      ),
      count('sales_to_pick', () =>
        salesPicking
          ? this.db.salesOrder.count({
              where: { ...salesPicking, status: { in: ['confirmed', 'picking'] } },
            })
          : null,
      ),
      count('sales_to_dispatch', () =>
        deliveryUse
          ? this.db.salesOrder.count({ where: { ...deliveryUse, status: 'packed' } })
          : null,
      ),
      count('draft_orders', () =>
        edit ? this.db.salesOrder.count({ where: { ...edit, status: 'draft' } }) : null,
      ),
    ]);
    return items.filter((i): i is AttentionItem => i !== null);
  }
}
