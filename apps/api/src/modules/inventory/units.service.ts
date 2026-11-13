import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type {
  CreateUnitOfMeasureRequest,
  ListUnitsQuery,
  StockUnit,
  UnitOfMeasure,
  UpdateUnitOfMeasureRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { inventoryErrors, isUniqueViolation } from './inventory-errors';

const UNIT_SELECT = {
  id: true,
  name: true,
  symbol: true,
  baseUnit: true,
  factor: true,
  archivedAt: true,
} as const;

interface UnitRow {
  id: string;
  name: string;
  symbol: string;
  baseUnit: StockUnit;
  factor: { toFixed(digits: number): string };
  archivedAt: Date | null;
}

/**
 * Units of measurement (docs/modules/inventory.md → Step 5, ADR 0038): a named number of base units, organization-wide.
 * Archived, never deleted; the base unit is fixed. Receipts convert with them (StockService.receive).
 */
@Injectable()
export class UnitsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(query: ListUnitsQuery): Promise<UnitOfMeasure[]> {
    const rows = await this.db.unitOfMeasure.findMany({
      where: query.includeArchived ? {} : { archivedAt: null },
      select: UNIT_SELECT,
      orderBy: [{ baseUnit: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(unitResponse);
  }

  async create(body: CreateUnitOfMeasureRequest): Promise<UnitOfMeasure> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const row = await tx.unitOfMeasure.create({
          data: {
            tenantId,
            name: body.name,
            symbol: body.symbol,
            baseUnit: body.baseUnit,
            factor: factorText(body.factor),
          },
          select: UNIT_SELECT,
        });
        const response = unitResponse(row);
        await this.audit.record(tx, {
          action: 'inventory.unit.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          after: snapshot('unit_of_measure', response),
        });
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async update(id: string, body: UpdateUnitOfMeasureRequest): Promise<UnitOfMeasure> {
    const { userId } = this.tenantContext.require();
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.unitOfMeasure.findUnique({ where: { id }, select: UNIT_SELECT });
        if (!current) throw inventoryErrors.unitNotFound([id]);
        const before = unitResponse(current);
        const archivedAt = nextArchivedAt(current.archivedAt, body.archived);
        const next: UnitOfMeasure = {
          ...before,
          name: body.name ?? before.name,
          symbol: body.symbol ?? before.symbol,
          factor: body.factor === undefined ? before.factor : factorText(body.factor),
          archivedAt: archivedAt?.toISOString() ?? null,
        };
        if (sameSnapshot(before, next)) return before;
        const row = await tx.unitOfMeasure.update({
          where: { id },
          data: { name: next.name, symbol: next.symbol, factor: next.factor, archivedAt },
          select: UNIT_SELECT,
        });
        const after = unitResponse(row);
        await this.audit.record(tx, {
          action: 'inventory.unit.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before: snapshot('unit_of_measure', before),
          after: snapshot('unit_of_measure', after),
        });
        return after;
      }),
    );
  }

  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw inventoryErrors.unitNameTaken();
      throw error;
    }
  }
}

const sameSnapshot = (a: UnitOfMeasure, b: UnitOfMeasure) =>
  JSON.stringify(snapshot('unit_of_measure', a)) === JSON.stringify(snapshot('unit_of_measure', b));

/** `archived`: true archives (keeping the first archive time), false restores, absent keeps. */
export function nextArchivedAt(current: Date | null, archived: boolean | undefined): Date | null {
  if (archived === undefined) return current;
  if (!archived) return null;
  return current ?? new Date();
}

/** The factor as the column stores it: 6 decimals. */
const factorText = (value: string) => new Decimal(value).toFixed(6);

function unitResponse(row: UnitRow): UnitOfMeasure {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    baseUnit: row.baseUnit,
    factor: row.factor.toFixed(6),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
