import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditActor,
  CreateDiningAreaRequest,
  DiningArea,
  ListDiningAreasQuery,
  UpdateDiningAreaRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { isUniqueViolation, posErrors } from './pos-errors';

const AREA_SELECT = { id: true, locationId: true, name: true, sortOrder: true } as const;

type AreaRow = { id: string; locationId: string; name: string; sortOrder: number };

/**
 * Areas of a location's floor (docs/modules/pos.md → Areas). Same keys and per-location checks as
 * tables: an area at a location where the caller can't read tables doesn't exist for them (404).
 * While the old `dining_tables.area` text exists (expand phase), a rename also updates it.
 */
@Injectable()
export class AreasService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(query: ListDiningAreasQuery): Promise<DiningArea[]> {
    const scope = await this.access.locationIdsFor('pos.tables.read');
    let locations: string[] | 'all' = scope;
    if (query.locationId) {
      locations = scope === 'all' || scope.includes(query.locationId) ? [query.locationId] : [];
    }
    if (locations !== 'all' && locations.length === 0) return [];
    const rows = await this.db.diningArea.findMany({
      where: locations === 'all' ? {} : { locationId: { in: locations } },
      select: {
        ...AREA_SELECT,
        _count: { select: { tables: { where: { archivedAt: null } } } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const live = await this.withLivePlan(rows.map((r) => r.id));
    return rows.map(({ _count, ...row }) => ({
      ...row,
      tableCount: _count.tables,
      livePlan: live.has(row.id),
    }));
  }

  /** `actor`: the signed-in user, or a system actor for bootstrap commands (seed-dev). */
  async create(body: CreateDiningAreaRequest, actor?: AuditActor): Promise<DiningArea> {
    const { tenantId, userId } = this.tenantContext.require();
    const location = await this.db.location.findUnique({
      where: { id: body.locationId },
      select: { id: true },
    });
    if (!location) throw posErrors.locationNotFound();
    await this.access.assert('pos.tables.create', { locationId: body.locationId });
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const row = await tx.diningArea.create({
          data: {
            tenantId,
            locationId: body.locationId,
            name: body.name,
            sortOrder: body.sortOrder ?? 0,
          },
          select: AREA_SELECT,
        });
        await this.audit.record(tx, {
          action: 'pos.dining_area.created',
          actor: actor ?? auditActor.user(userId),
          entityId: row.id,
          after: areaSnapshot(row),
        });
        const response = { ...row, tableCount: 0, livePlan: false };
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async update(id: string, body: UpdateDiningAreaRequest): Promise<DiningArea> {
    const { userId } = this.tenantContext.require();
    const found = await this.manageable(id, 'edit');
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.diningArea.findUnique({ where: { id }, select: AREA_SELECT });
        if (!current) throw posErrors.areaNotFound();
        const next = {
          ...current,
          name: body.name ?? current.name,
          sortOrder: body.sortOrder ?? current.sortOrder,
        };
        if (next.name !== current.name || next.sortOrder !== current.sortOrder) {
          await tx.diningArea.update({
            where: { id },
            data: { name: next.name, sortOrder: next.sortOrder },
          });
          if (next.name !== current.name) {
            // Expand phase (ADR 0004): keep the old text column equal to the area's name.
            await tx.diningTable.updateMany({ where: { areaId: id }, data: { area: next.name } });
          }
          await this.audit.record(tx, {
            action: 'pos.dining_area.updated',
            actor: auditActor.user(userId),
            entityId: id,
            before: areaSnapshot(current),
            after: areaSnapshot(next),
          });
        }
        const tableCount = await tx.diningTable.count({
          where: { areaId: id, archivedAt: null },
        });
        const livePlan = (await this.withLivePlan([id])).has(id);
        return { ...next, locationId: found.locationId, tableCount, livePlan };
      }),
    );
  }

  /** Deletes an area no table uses (also no table out of service); 409 otherwise. */
  async remove(id: string): Promise<void> {
    const { userId } = this.tenantContext.require();
    await this.manageable(id, 'delete');
    await this.db.$transaction(async (tx) => {
      const current = await tx.diningArea.findUnique({ where: { id }, select: AREA_SELECT });
      if (!current) throw posErrors.areaNotFound();
      if ((await tx.diningTable.count({ where: { areaId: id } })) > 0) {
        throw posErrors.areaNotEmpty();
      }
      await tx.diningArea.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'pos.dining_area.deleted',
        actor: auditActor.user(userId),
        entityId: id,
        before: areaSnapshot(current),
      });
    });
  }

  /** Those of the areas that have a published floor plan (ADR 0073). */
  private async withLivePlan(areaIds: string[]): Promise<Set<string>> {
    const rows = await this.db.posFloorPlanPublication.findMany({
      where: { areaId: { in: areaIds } },
      select: { areaId: true },
      distinct: ['areaId'],
    });
    return new Set(rows.map((r) => r.areaId));
  }

  /** The area, if the caller may read tables at its location (else 404) and manage them (else 403). */
  private async manageable(id: string, verb: 'edit' | 'delete') {
    const area = await this.db.diningArea.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!area || !(await this.access.can('pos.tables.read', { locationId: area.locationId }))) {
      throw posErrors.areaNotFound();
    }
    await this.access.assert(`pos.tables.${verb}`, { locationId: area.locationId });
    return area;
  }

  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw posErrors.areaNameTaken();
      throw error;
    }
  }
}

function areaSnapshot(row: AreaRow) {
  return snapshot('dining_area', row);
}
