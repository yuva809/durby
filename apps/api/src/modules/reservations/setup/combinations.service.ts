import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateCombinationRequest,
  ReservationCombination,
  UpdateCombinationRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../../platform/audit';
import { IdempotencyService } from '../../../platform/idempotency';
import { AccessService } from '../../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { PosFloorReader } from '../../pos';
import { reservationErrors } from '../reservations-errors';
import { readableLocation } from './table-rules.service';

const COMBINATION_SELECT = {
  id: true,
  locationId: true,
  name: true,
  minParty: true,
  maxParty: true,
  onlineBookable: true,
  archivedAt: true,
  tables: { select: { tableId: true }, orderBy: { tableId: 'asc' } },
} as const;

interface CombinationRow {
  id: string;
  locationId: string;
  name: string;
  minParty: number;
  maxParty: number;
  onlineBookable: boolean;
  archivedAt: Date | null;
  tables: { tableId: string }[];
}

/**
 * Table combinations (docs/modules/reservations.md → R1.5 setup API): tables of one location that
 * can be pushed together for one party. Archived, never deleted. Bookings store their own table
 * ids, so changing a combination never changes an existing booking.
 */
@Injectable()
export class CombinationsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly pos: PosFloorReader,
  ) {}

  async list(locationId: string, includeArchived: boolean): Promise<ReservationCombination[]> {
    await readableLocation(asTenantDb(this.db), this.access, locationId);
    const rows = await this.db.reservationCombination.findMany({
      where: { locationId, ...(includeArchived ? {} : { archivedAt: null }) },
      select: COMBINATION_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toResponse);
  }

  async create(body: CreateCombinationRequest): Promise<ReservationCombination> {
    const { tenantId, userId } = this.tenantContext.require();
    await readableLocation(asTenantDb(this.db), this.access, body.locationId);
    await this.access.assert('reservations.setup.manage', { locationId: body.locationId });
    checkRange(body.minParty, body.maxParty);
    await this.assertTablesInService(body.locationId, body.tableIds);
    return this.db.$transaction(async (tx) => {
      const { id } = await tx.reservationCombination.create({
        data: {
          tenantId,
          locationId: body.locationId,
          name: body.name,
          minParty: body.minParty,
          maxParty: body.maxParty,
          onlineBookable: body.onlineBookable ?? true,
        },
        select: { id: true },
      });
      await setTables(tx, tenantId, id, body.locationId, body.tableIds);
      const row = await read(tx, id);
      await this.audit.record(tx, {
        action: 'reservations.combination.created',
        actor: auditActor.user(userId),
        entityId: id,
        after: combinationSnapshot(row),
      });
      const response = toResponse(row);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  async update(id: string, body: UpdateCombinationRequest): Promise<ReservationCombination> {
    const { tenantId, userId } = this.tenantContext.require();
    const found = await this.db.reservationCombination.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (
      !found ||
      !(await this.access.can('reservations.bookings.read', { locationId: found.locationId }))
    ) {
      throw reservationErrors.combinationNotFound();
    }
    await this.access.assert('reservations.setup.manage', { locationId: found.locationId });
    if (body.tableIds) await this.assertTablesInService(found.locationId, body.tableIds);

    return this.db.$transaction(async (tx) => {
      const current = await read(tx, id);
      const next = {
        name: body.name ?? current.name,
        minParty: body.minParty ?? current.minParty,
        maxParty: body.maxParty ?? current.maxParty,
        onlineBookable: body.onlineBookable ?? current.onlineBookable,
        archivedAt:
          body.archived === undefined
            ? current.archivedAt
            : body.archived
              ? (current.archivedAt ?? new Date())
              : null,
      };
      checkRange(next.minParty, next.maxParty);
      const tableIds = body.tableIds ? [...body.tableIds].sort() : null;
      const tablesChanged =
        tableIds !== null && tableIds.join() !== current.tables.map((t) => t.tableId).join();
      const fieldsChanged =
        next.name !== current.name ||
        next.minParty !== current.minParty ||
        next.maxParty !== current.maxParty ||
        next.onlineBookable !== current.onlineBookable ||
        next.archivedAt?.getTime() !== current.archivedAt?.getTime();
      if (!tablesChanged && !fieldsChanged) return toResponse(current);

      if (fieldsChanged) await tx.reservationCombination.update({ where: { id }, data: next });
      if (tablesChanged) {
        await tx.reservationCombinationTable.deleteMany({ where: { combinationId: id } });
        await setTables(tx, tenantId, id, found.locationId, tableIds);
      }
      const updated = await read(tx, id);
      await this.audit.record(tx, {
        action: 'reservations.combination.updated',
        actor: auditActor.user(userId),
        entityId: id,
        before: combinationSnapshot(current),
        after: combinationSnapshot(updated),
      });
      return toResponse(updated);
    });
  }

  /** Every table at the location and in service (pos's read port), else 404. */
  private async assertTablesInService(locationId: string, tableIds: readonly string[]) {
    const inService = new Set((await this.pos.tablesAt(locationId)).map((t) => t.id));
    if (!tableIds.every((id) => inService.has(id))) throw reservationErrors.tableNotFound();
  }
}

function checkRange(minParty: number, maxParty: number) {
  if (minParty > maxParty) throw reservationErrors.partyRangeInvalid({ minParty, maxParty });
}

async function setTables(
  tx: TenantTransactionClient,
  tenantId: string,
  combinationId: string,
  locationId: string,
  tableIds: readonly string[],
) {
  await tx.reservationCombinationTable.createMany({
    data: tableIds.map((tableId) => ({ tenantId, combinationId, locationId, tableId })),
  });
}

async function read(tx: TenantTransactionClient, id: string): Promise<CombinationRow> {
  const row = await tx.reservationCombination.findUnique({
    where: { id },
    select: COMBINATION_SELECT,
  });
  if (!row) throw reservationErrors.combinationNotFound();
  return row;
}

function toResponse(row: CombinationRow): ReservationCombination {
  return {
    id: row.id,
    locationId: row.locationId,
    name: row.name,
    tableIds: row.tables.map((t) => t.tableId),
    minParty: row.minParty,
    maxParty: row.maxParty,
    onlineBookable: row.onlineBookable,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function combinationSnapshot(row: CombinationRow) {
  const { tables, ...fields } = row;
  return snapshot('reservation_combination', {
    ...fields,
    tableIds: tables.map((t) => t.tableId),
  });
}
