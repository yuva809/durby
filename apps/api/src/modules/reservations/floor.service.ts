import { Inject, Injectable } from '@nestjs/common';
import type { ReservationsFloorTable } from '@durby/shared';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../../platform/tenancy';
import { PosFloorReader } from '../pos';
import { reservationErrors } from './reservations-errors';

/**
 * The host floor (docs/modules/reservations.md → Derived floor state): a location's tables and
 * which of them an open pos order holds, read through pos's read port only (ADR 0019 §7). Nothing
 * about the orders beyond when they opened and their covers, so Host needs no pos order key. Later
 * steps add bookings to it (R1.8).
 */
@Injectable()
export class FloorService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly pos: PosFloorReader,
  ) {}

  async floor(locationId: string): Promise<ReservationsFloorTable[]> {
    // A location the caller can't read bookings at doesn't exist for them (404, like unknown ids).
    const scope = await this.access.locationIdsFor('reservations.bookings.read');
    if (scope !== 'all' && !scope.includes(locationId)) throw reservationErrors.locationNotFound();
    const location = await this.db.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) throw reservationErrors.locationNotFound();

    const [tables, open] = await Promise.all([
      this.pos.tablesAt(locationId),
      this.pos.openOrders(locationId),
    ]);
    const byTable = new Map(open.map((o) => [o.tableId, o]));
    return tables.map((table) => {
      const order = byTable.get(table.id);
      return {
        id: table.id,
        locationId: table.locationId,
        name: table.name,
        seats: table.seats,
        areaId: table.areaId,
        area: table.area,
        shape: table.shape,
        color: table.color,
        sortOrder: table.sortOrder,
        occupied: order !== undefined,
        occupiedSince: order?.openedAt.toISOString() ?? null,
        covers: order?.covers ?? null,
      };
    });
  }
}
