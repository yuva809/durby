import { Injectable } from '@nestjs/common';
import type { TenantDb } from '../../platform/tenancy';

const FACTS_SELECT = {
  id: true,
  locationId: true,
  startsAt: true,
  status: true,
  source: true,
  partySize: true,
  seatedAt: true,
  finishedAt: true,
} as const;

/**
 * reservations' read port for the reports (docs/modules/reports.md, ADR 0081): bookings as numbers, never guest data or
 * notes. In the caller's transaction and tenant (RLS); it checks no permission keys.
 */
@Injectable()
export class ReservationsReader {
  /** The bookings that exist. */
  async reservationFacts(ids: readonly string[], db: TenantDb) {
    const rows = await db.reservation.findMany({
      where: { id: { in: [...ids] } },
      select: FACTS_SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(({ id, ...rest }) => ({ reservationId: id, ...rest }));
  }

  /** Ids of bookings starting from `from` on (all without it), after `after`, in id order. */
  async reservationIds(
    page: { from?: Date | undefined; after?: string | undefined; take: number },
    db: TenantDb,
  ): Promise<string[]> {
    const rows = await db.reservation.findMany({
      where: {
        ...(page.from ? { startsAt: { gte: page.from } } : {}),
        ...(page.after ? { id: { gt: page.after } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: page.take,
    });
    return rows.map((r) => r.id);
  }
}
