import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditActor,
  CreateDiningTableRequest,
  DiningTable,
  ListDiningTablesQuery,
  UpdateDiningTableRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { isUniqueViolation, posErrors } from './pos-errors';

const TABLE_SELECT = {
  id: true,
  locationId: true,
  name: true,
  seats: true,
  areaId: true,
  area: true,
  shape: true,
  color: true,
  sortOrder: true,
  archivedAt: true,
  menuToken: true,
} as const;

type TableRow = Omit<DiningTable, 'archivedAt' | 'menuCode'> & {
  archivedAt: Date | null;
  menuToken: string;
};

/**
 * Dining tables per location (docs/modules/pos.md → Step 1). Both keys are location-scoped and
 * checked at the table's location: a table where the caller can't read tables doesn't exist for
 * them (404); one they can read but not manage is 403.
 */
@Injectable()
export class TablesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(query: ListDiningTablesQuery): Promise<DiningTable[]> {
    const scope = await this.access.locationIdsFor('pos.tables.read');
    let locations: string[] | 'all' = scope;
    if (query.locationId) {
      locations = scope === 'all' || scope.includes(query.locationId) ? [query.locationId] : [];
    }
    if (locations !== 'all' && locations.length === 0) return [];
    const rows = await this.db.diningTable.findMany({
      where: {
        ...(locations === 'all' ? {} : { locationId: { in: locations } }),
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      select: TABLE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(tableResponse);
  }

  /** `actor`: the signed-in user, or a system actor for bootstrap commands (seed-dev). */
  async create(body: CreateDiningTableRequest, actor?: AuditActor): Promise<DiningTable> {
    const { tenantId, userId } = this.tenantContext.require();
    const location = await this.db.location.findUnique({
      where: { id: body.locationId },
      select: { id: true },
    });
    if (!location) throw posErrors.locationNotFound();
    await this.access.assert('pos.tables.manage', { locationId: body.locationId });
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const area = body.areaId ? await areaAt(tx, body.areaId, body.locationId) : null;
        const row = await tx.diningTable.create({
          data: {
            tenantId,
            locationId: body.locationId,
            name: body.name,
            seats: body.seats,
            areaId: area?.id ?? null,
            area: area?.name ?? null,
            shape: body.shape ?? 'square',
            color: body.color ?? 'neutral',
            sortOrder: body.sortOrder ?? 0,
          },
          select: TABLE_SELECT,
        });
        await this.audit.record(tx, {
          action: 'pos.dining_table.created',
          actor: actor ?? auditActor.user(userId),
          entityId: row.id,
          after: tableSnapshot(row),
        });
        const response = tableResponse(row);
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async update(id: string, body: UpdateDiningTableRequest): Promise<DiningTable> {
    const { userId } = this.tenantContext.require();
    const found = await this.db.diningTable.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!found || !(await this.access.can('pos.tables.read', { locationId: found.locationId }))) {
      throw posErrors.tableNotFound();
    }
    await this.access.assert('pos.tables.manage', { locationId: found.locationId });
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.diningTable.findUnique({ where: { id }, select: TABLE_SELECT });
        if (!current) throw posErrors.tableNotFound();
        const area =
          body.areaId === undefined
            ? { id: current.areaId, name: current.area }
            : body.areaId === null
              ? { id: null, name: null }
              : await areaAt(tx, body.areaId, current.locationId);
        const data = {
          name: body.name ?? current.name,
          seats: body.seats ?? current.seats,
          areaId: area.id,
          area: area.name,
          shape: body.shape ?? current.shape,
          color: body.color ?? current.color,
          sortOrder: body.sortOrder ?? current.sortOrder,
          archivedAt: archivedAt(current.archivedAt, body.archived),
        };
        const before = tableSnapshot(current);
        if (JSON.stringify(before) === JSON.stringify(tableSnapshot({ ...current, ...data }))) {
          return tableResponse(current);
        }
        const row = await tx.diningTable.update({ where: { id }, data, select: TABLE_SELECT });
        await this.audit.record(tx, {
          action: 'pos.dining_table.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before,
          after: tableSnapshot(row),
        });
        return tableResponse(row);
      }),
    );
  }

  /**
   * A new QR menu token (docs/modules/pos.md → QR menu, ADR 0026): the table's old QR stops
   * working. Audited without the token (not in the snapshot allow-list).
   */
  async rotateMenuToken(id: string): Promise<DiningTable> {
    const { userId } = this.tenantContext.require();
    const found = await this.db.diningTable.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!found || !(await this.access.can('pos.tables.read', { locationId: found.locationId }))) {
      throw posErrors.tableNotFound();
    }
    await this.access.assert('pos.tables.manage', { locationId: found.locationId });
    return this.db.$transaction(async (tx) => {
      const row = await tx.diningTable.update({
        where: { id },
        data: { menuToken: newMenuToken() },
        select: TABLE_SELECT,
      });
      await this.audit.record(tx, {
        action: 'pos.dining_table.menu_token_rotated',
        actor: auditActor.user(userId),
        entityId: id,
        after: tableSnapshot(row),
      });
      return tableResponse(row);
    });
  }

  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw posErrors.tableNameTaken();
      throw error;
    }
  }
}

/** The area, if it exists here and is at `locationId` (a table's area is at its location). */
async function areaAt(tx: TenantTransactionClient, areaId: string, locationId: string) {
  const area = await tx.diningArea.findUnique({
    where: { id: areaId },
    select: { id: true, name: true, locationId: true },
  });
  if (!area || area.locationId !== locationId) throw posErrors.areaNotFound();
  return area;
}

/** `archived`: true archives (keeping the first archive time), false restores, absent keeps. */
function archivedAt(current: Date | null, archived: boolean | undefined): Date | null {
  if (archived === undefined) return current;
  if (!archived) return null;
  return current ?? new Date();
}

/** 24 URL-safe characters (18 random bytes), like the database default pos_new_menu_token(). */
function newMenuToken(): string {
  return randomBytes(18).toString('base64url');
}

function tableResponse({ menuToken, ...row }: TableRow): DiningTable {
  return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null, menuCode: menuToken };
}

function tableSnapshot(row: TableRow) {
  return snapshot('dining_table', row);
}
