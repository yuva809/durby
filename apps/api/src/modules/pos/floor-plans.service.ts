import { Inject, Injectable } from '@nestjs/common';
import {
  type AreaFloorPlanResponse,
  FLOOR_PLAN_HISTORY,
  type FloorPlanLayout,
  floorPlanLayoutSchema,
  type FloorPlanVersion,
  type LivePlan,
  type PublishFloorPlanResponse,
  type SaveFloorPlanRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService, MemberNames } from '../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantDb,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { isUniqueViolation, posErrors } from './pos-errors';
import { TablesService } from './tables.service';

interface Area {
  id: string;
  locationId: string;
  name: string;
}

interface VersionRow {
  id: string;
  version: number;
  restoredFrom: number | null;
  layout: unknown;
}

const AREA_SELECT = { id: true, locationId: true, name: true } as const;
const VERSION_SELECT = { id: true, version: true, restoredFrom: true, layout: true } as const;

/**
 * Floor plans of areas (docs/modules/pos.md → Step 8, ADR 0073). Versions and publications are append-only; the newest
 * publication of an area is live. Writes lock the area's row, so they run one after the other per area. An area at a
 * location where the caller can't read tables doesn't exist for them (404).
 */
@Injectable()
export class FloorPlansService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly members: MemberNames,
    private readonly tables: TablesService,
  ) {}

  async area(areaId: string): Promise<AreaFloorPlanResponse> {
    const area = await this.readable(areaId);
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.posFloorPlanVersion.findMany({
          where: { areaId },
          select: { ...VERSION_SELECT, createdAt: true, createdByUserId: true },
          orderBy: { version: 'desc' },
          take: FLOOR_PLAN_HISTORY,
        });
        const names = await this.members.forUsers(
          asTenantDb(tx),
          rows.map((r) => r.createdByUserId),
        );
        return {
          area,
          latest: rows[0] ? versionResponse(rows[0]) : null,
          live: await this.live(tx, areaId),
          history: rows.map((row) => {
            const layout = layoutOf(row);
            return {
              version: row.version,
              restoredFrom: row.restoredFrom,
              tables: layout.tables.length,
              pieces: layout.pieces.length,
              createdAt: row.createdAt.toISOString(),
              createdBy: names.get(row.createdByUserId) ?? null,
            };
          }),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async version(areaId: string, version: number): Promise<FloorPlanVersion> {
    await this.readable(areaId);
    return versionResponse(await this.require(asTenantDb(this.db), areaId, version));
  }

  /** The live plans of a location, for the floor (`pos.orders.read` there; else the location doesn't exist). */
  async livePlans(locationId: string): Promise<LivePlan[]> {
    const location = await this.db.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location || !(await this.access.can('pos.orders.read', { locationId }))) {
      throw posErrors.locationNotFound();
    }
    return this.db.$transaction(
      async (tx) => {
        const areas = await tx.diningArea.findMany({
          where: { locationId },
          select: AREA_SELECT,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        });
        const plans: LivePlan[] = [];
        for (const area of areas) {
          const live = await this.live(tx, area.id);
          if (live) plans.push({ areaId: area.id, areaName: area.name, ...live });
        }
        return plans;
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async save(areaId: string, body: SaveFloorPlanRequest): Promise<FloorPlanVersion> {
    const area = await this.editable(areaId);
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, area);
      await this.assertNewest(tx, areaId, body.baseVersion);
      await assertTables(tx, area, body.layout);
      const row = await this.write(tx, area, body.layout, 'pos.floor_plan.saved');
      const response = versionResponse(row);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** A new version that copies `version` as it was, also when its tables have left the area since. */
  async restore(areaId: string, version: number, baseVersion: number): Promise<FloorPlanVersion> {
    const area = await this.editable(areaId);
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, area);
      await this.assertNewest(tx, areaId, baseVersion);
      const source = await this.require(asTenantDb(tx), areaId, version);
      const row = await this.write(
        tx,
        area,
        layoutOf(source),
        'pos.floor_plan.restored',
        source.version,
      );
      const response = versionResponse(row);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /**
   * Makes a version live. Its new tables are created first, and the version that goes live then names them. Nothing
   * happens when the version is live already.
   */
  async publish(areaId: string, version: number): Promise<PublishFloorPlanResponse> {
    const area = await this.editable(areaId);
    const { userId, tenantId } = this.tenantContext.require();
    try {
      return await this.db.$transaction(async (tx) => {
        await this.lock(tx, area);
        let row = await this.require(asTenantDb(tx), areaId, version);
        const layout = layoutOf(row);
        const created: PublishFloorPlanResponse['created'] = [];
        const fresh = layout.tables.filter((t) => t.create !== null);
        if (fresh.length > 0) {
          await this.access.assert('pos.tables.create', { locationId: area.locationId });
          const ids = new Map<string, string>();
          for (const { key, create } of fresh) {
            const table = await this.tables.insert(
              tx,
              { locationId: area.locationId, areaId, ...create! },
              auditActor.user(userId),
            );
            ids.set(key, table.id);
            created.push({ id: table.id, name: table.name });
          }
          row = await this.write(
            tx,
            area,
            {
              ...layout,
              tables: layout.tables.map((t) =>
                t.create ? { ...t, tableId: ids.get(t.key)!, create: null } : t,
              ),
            },
            'pos.floor_plan.saved',
          );
        }
        if ((await this.live(tx, areaId))?.version !== row.version) {
          await tx.posFloorPlanPublication.create({
            data: {
              tenantId,
              locationId: area.locationId,
              areaId,
              versionId: row.id,
              createdByUserId: userId,
            },
          });
          await this.audit.record(tx, {
            action: 'pos.floor_plan.published',
            actor: auditActor.user(userId),
            entityId: row.id,
            after: planSnapshot(area, row),
          });
        }
        const response = { ...versionResponse(row), created };
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw posErrors.tableNameTaken();
      throw error;
    }
  }

  private async write(
    tx: TenantTransactionClient,
    area: Area,
    layout: FloorPlanLayout,
    action: 'pos.floor_plan.saved' | 'pos.floor_plan.restored',
    restoredFrom: number | null = null,
  ): Promise<VersionRow> {
    const { tenantId, userId } = this.tenantContext.require();
    const row = await tx.posFloorPlanVersion.create({
      data: {
        tenantId,
        locationId: area.locationId,
        areaId: area.id,
        version: (await newest(tx, area.id)) + 1,
        restoredFrom,
        layout,
        createdByUserId: userId,
      },
      select: VERSION_SELECT,
    });
    await this.audit.record(tx, {
      action,
      actor: auditActor.user(userId),
      entityId: row.id,
      after: planSnapshot(area, row),
    });
    return row;
  }

  /** The newest publication by insertion order (ids and times aren't strictly ordered). */
  private async live(
    tx: TenantTransactionClient,
    areaId: string,
  ): Promise<FloorPlanVersion | null> {
    const found = await tx.posFloorPlanPublication.findFirst({
      where: { areaId },
      select: { version: { select: VERSION_SELECT } },
      orderBy: { seq: 'desc' },
    });
    return found ? versionResponse(found.version) : null;
  }

  private async require(db: TenantDb, areaId: string, version: number): Promise<VersionRow> {
    const row = await db.posFloorPlanVersion.findFirst({
      where: { areaId, version },
      select: VERSION_SELECT,
    });
    if (!row) throw posErrors.floorPlanNotFound();
    return row;
  }

  private async assertNewest(tx: TenantTransactionClient, areaId: string, baseVersion: number) {
    if ((await newest(tx, areaId)) !== baseVersion) throw posErrors.floorPlanChanged();
  }

  /** Keeps other writes on this plan, and the area's deletion, waiting. */
  private async lock(tx: TenantTransactionClient, area: Area): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM dining_areas WHERE id = ${area.id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw posErrors.areaNotFound();
  }

  private async readable(areaId: string): Promise<Area> {
    const area = await this.db.diningArea.findUnique({
      where: { id: areaId },
      select: AREA_SELECT,
    });
    if (!area || !(await this.access.can('pos.tables.read', { locationId: area.locationId }))) {
      throw posErrors.areaNotFound();
    }
    return area;
  }

  private async editable(areaId: string): Promise<Area> {
    const area = await this.readable(areaId);
    await this.access.assert('pos.tables.edit', { locationId: area.locationId });
    return area;
  }
}

async function newest(tx: TenantTransactionClient, areaId: string): Promise<number> {
  const row = await tx.posFloorPlanVersion.findFirst({
    where: { areaId },
    select: { version: true },
    orderBy: { version: 'desc' },
  });
  return row?.version ?? 0;
}

/** Every existing table of the layout is in the area and in service. */
async function assertTables(
  tx: TenantTransactionClient,
  area: Area,
  layout: FloorPlanLayout,
): Promise<void> {
  const ids = layout.tables.flatMap((t) => (t.tableId ? [t.tableId] : []));
  const found = await tx.diningTable.count({
    where: { id: { in: ids }, areaId: area.id, archivedAt: null },
  });
  if (found !== ids.length) throw posErrors.floorPlanTableInvalid();
}

/** Stored layouts were validated when written; parsing again keeps the type honest. */
const layoutOf = (row: Pick<VersionRow, 'layout'>): FloorPlanLayout =>
  floorPlanLayoutSchema.parse(row.layout);

const versionResponse = (row: VersionRow): FloorPlanVersion => ({
  version: row.version,
  layout: layoutOf(row),
});

function planSnapshot(area: Area, row: VersionRow) {
  const layout = layoutOf(row);
  return snapshot('floor_plan', {
    id: row.id,
    locationId: area.locationId,
    areaId: area.id,
    version: row.version,
    restoredFrom: row.restoredFrom,
    tableCount: layout.tables.length,
    pieceCount: layout.pieces.length,
  });
}
