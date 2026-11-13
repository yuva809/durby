import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { Bom, PutBomRequest, StockUnit } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantDb,
  type TenantPrismaClient,
} from '../../platform/tenancy';
import { inventoryErrors } from './inventory-errors';

const BOM_SELECT = {
  itemId: true,
  outputQuantity: true,
  updatedAt: true,
  item: { select: { name: true, unit: true } },
  lines: {
    select: {
      itemId: true,
      quantity: true,
      item: { select: { name: true, unit: true } },
    },
  },
} as const;

interface BomRow {
  itemId: string;
  outputQuantity: { toFixed(digits: number): string };
  updatedAt: Date;
  item: { name: string; unit: StockUnit };
  lines: {
    itemId: string;
    quantity: { toFixed(digits: number): string };
    item: { name: string; unit: StockUnit };
  }[];
}

/**
 * Bills of materials (docs/modules/inventory.md → Step 5, ADR 0038): what an output quantity of a prepared stock item
 * takes. Configuration like recipes: replaced as a whole, deleted freely, every change audited. Production orders
 * (StockService.produce) book them.
 */
@Injectable()
export class BomsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<Bom[]> {
    const rows: BomRow[] = await this.db.bom.findMany({
      select: BOM_SELECT,
      orderBy: [{ item: { name: 'asc' } }, { id: 'asc' }],
    });
    return rows.map(bomResponse);
  }

  async get(itemId: string): Promise<Bom> {
    const row = await bomOf(asTenantDb(this.db), itemId);
    if (!row) throw inventoryErrors.bomNotFound();
    return row;
  }

  /** Creates or replaces the item's bill; the same bill again changes nothing. */
  async put(itemId: string, body: PutBomRequest): Promise<Bom> {
    const { tenantId, userId } = this.tenantContext.require();
    if (body.lines.some((l) => l.itemId === itemId)) throw inventoryErrors.bomInvalid();
    return this.db.$transaction(async (tx) => {
      const ids = [itemId, ...body.lines.map((l) => l.itemId)];
      const items = await tx.stockItem.findMany({
        where: { id: { in: ids }, archivedAt: null },
        select: { id: true, _count: { select: { variants: { where: { archivedAt: null } } } } },
      });
      const found = new Map(items.map((i) => [i.id, i]));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) throw inventoryErrors.itemNotFound(missing);
      const parents = ids.filter((id) => found.get(id)!._count.variants > 0);
      if (parents.length > 0) throw inventoryErrors.itemHasVariants(parents);

      const current = await tx.bom.findUnique({
        where: { tenantId_itemId: { tenantId, itemId } },
        select: {
          id: true,
          outputQuantity: true,
          lines: { select: { itemId: true, quantity: true } },
        },
      });
      const next = {
        outputQuantity: new Decimal(body.outputQuantity).toFixed(3),
        lines: body.lines.map((l) => ({
          itemId: l.itemId,
          quantity: new Decimal(l.quantity).toFixed(3),
        })),
      };
      const before = current && {
        outputQuantity: current.outputQuantity.toFixed(3),
        lines: current.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity.toFixed(3) })),
      };
      if (before && bomKey(before) === bomKey(next)) return (await bomOf(tx, itemId))!;

      let bomId: string;
      if (current) {
        bomId = current.id;
        await tx.bomLine.deleteMany({ where: { bomId } });
        await tx.bom.update({
          where: { id: bomId },
          data: { outputQuantity: next.outputQuantity },
        });
      } else {
        ({ id: bomId } = await tx.bom.create({
          data: { tenantId, itemId, outputQuantity: next.outputQuantity },
          select: { id: true },
        }));
      }
      await tx.bomLine.createMany({
        data: next.lines.map((l) => ({ tenantId, bomId, itemId: l.itemId, quantity: l.quantity })),
      });
      await this.audit.record(tx, {
        action: 'inventory.bom.updated',
        actor: auditActor.user(userId),
        entityId: itemId,
        ...(before && { before: bomSnapshot(itemId, before) }),
        after: bomSnapshot(itemId, next),
      });
      return (await bomOf(tx, itemId))!;
    });
  }

  async remove(itemId: string): Promise<void> {
    const { tenantId, userId } = this.tenantContext.require();
    await this.db.$transaction(async (tx) => {
      const current = await tx.bom.findUnique({
        where: { tenantId_itemId: { tenantId, itemId } },
        select: {
          id: true,
          outputQuantity: true,
          lines: { select: { itemId: true, quantity: true } },
        },
      });
      if (!current) throw inventoryErrors.bomNotFound();
      await tx.bom.delete({ where: { id: current.id } });
      await this.audit.record(tx, {
        action: 'inventory.bom.deleted',
        actor: auditActor.user(userId),
        entityId: itemId,
        before: bomSnapshot(itemId, {
          outputQuantity: current.outputQuantity.toFixed(3),
          lines: current.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity.toFixed(3) })),
        }),
      });
    });
  }
}

/** The item's bill with names, or null. */
export async function bomOf(db: TenantDb, itemId: string): Promise<Bom | null> {
  const row: BomRow | null = await db.bom.findFirst({ where: { itemId }, select: BOM_SELECT });
  return row && bomResponse(row);
}

type BomValues = { outputQuantity: string; lines: { itemId: string; quantity: string }[] };

const bomKey = (bom: BomValues) =>
  `${bom.outputQuantity}|${bom.lines
    .map((l) => `${l.itemId}:${l.quantity}`)
    .sort()
    .join(',')}`;

/** Flat snapshot (ADR 0008): the item, output quantity, how many components and which. */
function bomSnapshot(itemId: string, bom: BomValues) {
  return snapshot('bom', {
    itemId,
    outputQuantity: bom.outputQuantity,
    lineCount: bom.lines.length,
    itemIds: bom.lines
      .map((l) => l.itemId)
      .sort()
      .join(','),
  });
}

function bomResponse(row: BomRow): Bom {
  return {
    itemId: row.itemId,
    itemName: row.item.name,
    unit: row.item.unit,
    outputQuantity: row.outputQuantity.toFixed(3),
    lines: row.lines
      .map((l) => ({
        itemId: l.itemId,
        itemName: l.item.name,
        unit: l.item.unit,
        quantity: l.quantity.toFixed(3),
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemId.localeCompare(b.itemId)),
    updatedAt: row.updatedAt.toISOString(),
  };
}
