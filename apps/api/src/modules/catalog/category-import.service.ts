import { Inject, Injectable } from '@nestjs/common';
import {
  checkCategoryRows,
  type DataImportResult,
  type ImportCategoriesRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { catalogErrors } from './catalog-errors';

/**
 * Import Data → Product categories (docs/platform/import.md, ADR 0044 step 4): names not there yet (case-insensitive,
 * among active categories) are added at the end of the menu order; the others are left as they are. One transaction.
 */
@Injectable()
export class CategoryImportService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async importCategories(body: ImportCategoriesRequest): Promise<DataImportResult> {
    const problems = checkCategoryRows(body.rows);
    if (problems.length > 0) throw catalogErrors.categoryImportInvalid(problems);
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      const existing = await tx.productCategory.findMany({
        where: { archivedAt: null },
        select: { name: true, sortOrder: true },
      });
      const names = new Set(existing.map((c) => c.name.toLowerCase()));
      let sortOrder = existing.reduce((max, c) => Math.max(max, c.sortOrder), -1);
      const result: DataImportResult = { created: 0, updated: 0, unchanged: 0, documents: [] };
      for (const row of body.rows) {
        const name = row.name.trim();
        if (names.has(name.toLowerCase())) {
          result.unchanged += 1;
          continue;
        }
        sortOrder += 1;
        const created = await tx.productCategory.create({
          data: { tenantId, name, sortOrder, station: 'kitchen' },
          select: { id: true, name: true, sortOrder: true, station: true, archivedAt: true },
        });
        await this.audit.record(tx, {
          action: 'catalog.product_category.created',
          actor: auditActor.user(userId),
          entityId: created.id,
          after: snapshot('product_category', created),
        });
        names.add(name.toLowerCase());
        result.created += 1;
      }
      await this.idempotency.completeInTransaction(tx, result);
      return result;
    });
  }
}
