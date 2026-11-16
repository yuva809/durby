import { Inject, Injectable } from '@nestjs/common';
import { SEARCH_LIMIT_PER_TYPE, type SearchResult } from '@durby/shared';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../../platform/tenancy';

/** Catalog's part of the top bar search (ADR 0046): active products by name or menu number. */
@Injectable()
export class CatalogLookup {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
  ) {}

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
