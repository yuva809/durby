import { Inject, Injectable } from '@nestjs/common';
import { SEARCH_LIMIT_PER_TYPE, type SearchResult } from '@durby/shared';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, type TenantDb, type TenantPrismaClient } from '../../platform/tenancy';

/** Catalog's part of the top bar search (ADR 0046): active products by name or menu number. */
@Injectable()
export class CatalogLookup {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
  ) {}

  /**
   * Products and the category each is in now, archived ones included, in the caller's transaction (reports, ADR 0081).
   * Checks no permission keys.
   */
  async productsByIds(
    ids: readonly string[],
    db: TenantDb,
  ): Promise<Map<string, { name: string; categoryId: string; categoryName: string }>> {
    const rows = await db.product.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, category: { select: { id: true, name: true } } },
    });
    return new Map(
      rows.map((p) => [
        p.id,
        { name: p.name, categoryId: p.category.id, categoryName: p.category.name },
      ]),
    );
  }

  async searchProducts(q: string): Promise<SearchResult[]> {
    const scope = await this.access.locationIdsFor('catalog.products.read');
    if (scope !== 'all' && scope.length === 0) return [];
    const rows = await this.db.product.findMany({
      where: {
        archivedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { menuNumber: { equals: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, menuNumber: true, category: { select: { name: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: SEARCH_LIMIT_PER_TYPE,
    });
    return rows.map((p) => ({
      type: 'product',
      id: p.id,
      title: p.menuNumber ? `${p.menuNumber} · ${p.name}` : p.name,
      subtitle: p.category.name,
    }));
  }
}
