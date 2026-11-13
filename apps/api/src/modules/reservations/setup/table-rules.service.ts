import { Inject, Injectable } from '@nestjs/common';
import type { PutTableRuleRequest, ReservationTable, TableBookingMode } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../../platform/audit';
import { AccessService } from '../../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantDb,
  type TenantPrismaClient,
} from '../../../platform/tenancy';
import { type FloorTable, PosFloorReader } from '../../pos';
import { reservationErrors } from '../reservations-errors';

interface Rule {
  bookingMode: TableBookingMode;
  minParty: number;
  maxParty: number | null;
}

const DEFAULT_RULE: Rule = { bookingMode: 'all', minParty: 1, maxParty: null };

/**
 * Table rules (docs/modules/reservations.md → R1.5 setup API): who may book a table and for which
 * party sizes. Tables come from pos's read port; a table without a stored rule has the defaults.
 */
@Injectable()
export class TableRulesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly pos: PosFloorReader,
  ) {}

  /** The location's tables in service with their rules. */
  async list(locationId: string): Promise<ReservationTable[]> {
    await readableLocation(asTenantDb(this.db), this.access, locationId);
    const [tables, rules] = await Promise.all([
      this.pos.tablesAt(locationId),
      this.db.reservationTableRule.findMany({
        where: { locationId },
        select: { tableId: true, bookingMode: true, minParty: true, maxParty: true },
      }),
    ]);
    const ruleOf = new Map(rules.map((r) => [r.tableId, r]));
    return tables.map((t) => withRule(t, ruleOf.get(t.id) ?? DEFAULT_RULE));
  }

  /** Creates or replaces the rule; an unchanged rule writes nothing (no audit row). */
  async put(tableId: string, body: PutTableRuleRequest): Promise<ReservationTable> {
    const { tenantId, userId } = this.tenantContext.require();
    const table = await this.pos.table(tableId);
    if (
      !table ||
      table.archivedAt !== null ||
      !(await this.access.can('reservations.bookings.read', { locationId: table.locationId }))
    ) {
      throw reservationErrors.tableNotFound();
    }
    await this.access.assert('reservations.setup.edit', { locationId: table.locationId });
    const next: Rule = {
      bookingMode: body.bookingMode,
      minParty: body.minParty,
      maxParty: body.maxParty,
    };
    if (next.minParty > (next.maxParty ?? table.seats)) {
      throw reservationErrors.partyRangeInvalid({
        minParty: next.minParty,
        maxParty: next.maxParty ?? table.seats,
      });
    }

    await this.db.$transaction(async (tx) => {
      const current = await tx.reservationTableRule.findUnique({
        where: { tenantId_tableId: { tenantId, tableId } },
        select: { bookingMode: true, minParty: true, maxParty: true },
      });
      if (current && sameRule(current, next)) return;
      await tx.reservationTableRule.upsert({
        where: { tenantId_tableId: { tenantId, tableId } },
        create: { tenantId, tableId, locationId: table.locationId, ...next },
        update: next,
      });
      await this.audit.record(tx, {
        action: 'reservations.table_rule.updated',
        actor: auditActor.user(userId),
        entityId: tableId,
        ...(current && { before: ruleSnapshot(tableId, current) }),
        after: ruleSnapshot(tableId, next),
      });
    });
    return withRule(table, next);
  }
}

/**
 * The location, if it exists in this tenant and the caller reads bookings there; otherwise it
 * doesn't exist for them (404, like unknown ids). Writes pass their own `tx` (ADR 0021: no extra
 * transaction per request).
 */
export async function readableLocation(
  db: TenantDb,
  access: AccessService,
  locationId: string,
): Promise<void> {
  const scope = await access.locationIdsFor('reservations.bookings.read');
  if (scope !== 'all' && !scope.includes(locationId)) throw reservationErrors.locationNotFound();
  const location = await db.location.findUnique({
    where: { id: locationId },
    select: { id: true },
  });
  if (!location) throw reservationErrors.locationNotFound();
}

function withRule(table: FloorTable, rule: Rule): ReservationTable {
  return {
    id: table.id,
    locationId: table.locationId,
    name: table.name,
    seats: table.seats,
    areaId: table.areaId,
    area: table.area,
    sortOrder: table.sortOrder,
    bookingMode: rule.bookingMode,
    minParty: rule.minParty,
    maxParty: rule.maxParty,
  };
}

const sameRule = (a: Rule, b: Rule) =>
  a.bookingMode === b.bookingMode && a.minParty === b.minParty && a.maxParty === b.maxParty;

const ruleSnapshot = (tableId: string, rule: Rule) =>
  snapshot('reservation_table_rule', { tableId, ...rule });
