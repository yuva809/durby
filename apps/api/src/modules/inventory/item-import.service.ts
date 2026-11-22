import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { LOCALES } from '@durby/i18n';
import {
  checkItemRows,
  itemRowPack,
  STOCK_UNITS,
  type UnitLabels,
  type DataImportResult,
  type ImportItemsRequest,
  type StockItem,
  type StockUnit,
} from '@durby/shared';
import { auditActor, AuditService } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { LabelService } from '../../platform/labels';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { inventoryErrors, isUniqueViolation } from './inventory-errors';
import { ITEM_SELECT, itemResponse, itemSnapshot } from './setup.service';

/**
 * Import Data → stock items (docs/platform/import.md, ADR 0044 step 4): a row meets an active item by SKU when it has
 * one, else by name (case-insensitive); it is created when there is none, updated when something differs. An item's
 * unit can't change once it has movements. Updating needs `inventory.items.edit` as well. One transaction.
 */
@Injectable()
export class ItemImportService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly labels: LabelService,
  ) {}

  /**
   * The names the organization shows for each unit, as the browser checks them (its labels, in every locale: the api
   * does not know the person's language, so a name valid in any of them is accepted; a unit's code always is).
   */
  private async unitNames(): Promise<UnitLabels> {
    const names = new Map<StockUnit, string[]>();
    for (const locale of LOCALES) {
      const t = await this.labels.translator(locale);
      for (const unit of STOCK_UNITS) {
        names.set(unit, [...(names.get(unit) ?? []), t(`inventory.units.${unit}`)]);
      }
    }
    return (unit) => names.get(unit) ?? unit;
  }

  async importItems(body: ImportItemsRequest): Promise<DataImportResult> {
    const labelOf = await this.unitNames();
    const problems = checkItemRows(body.rows, labelOf);
    if (problems.length > 0) throw inventoryErrors.importInvalid(problems);
    const { tenantId, userId } = this.tenantContext.require();
    const canEdit = await this.access.can('inventory.items.edit');
    try {
      return await this.db.$transaction(async (tx) => {
        const items = await tx.stockItem.findMany({
          where: { archivedAt: null },
          select: { ...ITEM_SELECT, _count: { select: { movements: true } } },
        });
        const bySku = new Map(items.filter((i) => i.sku).map((i) => [i.sku!.toLowerCase(), i]));
        const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));
        const result: DataImportResult = { created: 0, updated: 0, unchanged: 0, documents: [] };
        const unitLocked: number[] = [];

        for (const [index, row] of body.rows.entries()) {
          const sku = row.sku?.trim() || null;
          const current = sku
            ? bySku.get(sku.toLowerCase())
            : byName.get(row.name.trim().toLowerCase());
          const unit = row.unit.trim().toLowerCase() as StockUnit;
          const minQuantity = row.minQuantity?.trim()
            ? new Decimal(row.minQuantity.trim()).toFixed(3)
            : null;
          const salePrice = row.salePrice?.trim()
            ? new Decimal(row.salePrice.trim()).toFixed(2)
            : null;
          const brand = row.brand?.trim() || null;
          const pack = itemRowPack(row.packSize, labelOf);
          if (!current) {
            const created = await tx.stockItem.create({
              data: {
                tenantId,
                name: row.name.trim(),
                sku,
                unit,
                minQuantity,
                salePrice,
                brand,
                packCount: pack?.packCount ?? null,
                packSize: pack?.packSize ? new Decimal(pack.packSize).toFixed(3) : null,
                packUnit: pack?.packUnit ?? null,
              },
              select: ITEM_SELECT,
            });
            await this.audit.record(tx, {
              action: 'inventory.stock_item.created',
              actor: auditActor.user(userId),
              entityId: created.id,
              after: itemSnapshot(itemResponse(created)),
            });
            result.created += 1;
            continue;
          }
          const before = itemResponse(current);
          const next: StockItem = {
            ...before,
            name: row.name.trim(),
            sku: sku ?? before.sku,
            unit,
            // Empty cells keep what the item has.
            minQuantity: minQuantity ?? before.minQuantity,
            salePrice: salePrice ?? before.salePrice,
            brand: brand ?? before.brand,
            // A pack size cell replaces the whole pack size; an empty one keeps it.
            ...(pack
              ? {
                  packCount: pack.packCount ?? null,
                  packSize: pack.packSize ? new Decimal(pack.packSize).toFixed(3) : null,
                  packUnit: pack.packUnit ?? null,
                }
              : {}),
          };
          if (JSON.stringify(before) === JSON.stringify(next)) {
            result.unchanged += 1;
            continue;
          }
          if (next.unit !== before.unit && current._count.movements > 0) {
            unitLocked.push(index + 1);
            continue;
          }
          if (!canEdit) await this.access.assert('inventory.items.edit');
          const updated = await tx.stockItem.update({
            where: { id: current.id },
            data: {
              name: next.name,
              sku: next.sku,
              unit: next.unit,
              minQuantity: next.minQuantity,
              salePrice: next.salePrice,
              brand: next.brand,
              packCount: next.packCount,
              packSize: next.packSize,
              packUnit: next.packUnit,
            },
            select: ITEM_SELECT,
          });
          await this.audit.record(tx, {
            action: 'inventory.stock_item.updated',
            actor: auditActor.user(userId),
            entityId: current.id,
            before: itemSnapshot(before),
            after: itemSnapshot(itemResponse(updated)),
          });
          result.updated += 1;
        }
        if (unitLocked.length > 0) {
          throw inventoryErrors.importInvalid(
            unitLocked.map((row) => ({ row, field: 'unit', problem: 'invalid' as const })),
          );
        }
        await this.idempotency.completeInTransaction(tx, result);
        return result;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw inventoryErrors.itemNameTaken();
      throw error;
    }
  }
}
