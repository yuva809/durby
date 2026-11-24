import { Injectable } from '@nestjs/common';
import { asTenantDb, TenantContext, type TenantTransactionClient } from '../../platform/tenancy';
import { PosSalesReader } from '../pos';
import { ReservationsReader } from '../reservations';

/**
 * Writes the read model (docs/modules/reports.md, ADR 0081). It never adds up: it recomputes whole orders and bookings
 * from their modules' read ports and replaces their rows, so redelivered, late or reordered events end the same. The
 * advisory lock comes before the read (read committed): of two handlers for one order, the second sees what the first
 * saw and more.
 */
@Injectable()
export class ReportsProjection {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly sales: PosSalesReader,
    private readonly reservations: ReservationsReader,
  ) {}

  /** The order, and those whose items are on it after a merge. */
  async order(orderId: string, tx: TenantTransactionClient): Promise<void> {
    await this.orders(await this.sales.relatedOrders(orderId, asTenantDb(tx)), tx);
  }

  /** Recomputes these orders; the rows of orders that no longer exist are removed. */
  async orders(orderIds: readonly string[], tx: TenantTransactionClient): Promise<void> {
    const ids = [...new Set(orderIds)].sort();
    if (ids.length === 0) return;
    const { tenantId } = this.tenantContext.require();
    await lock(tx, 'order', ids);
    const facts = await this.sales.orderFacts(ids, asTenantDb(tx));
    await tx.reportLineFact.deleteMany({ where: { orderId: { in: ids } } });
    await tx.reportOrderFact.deleteMany({ where: { orderId: { in: ids } } });
    if (facts.length === 0) return;
    await tx.reportOrderFact.createMany({
      data: facts.map(({ lines, ...order }) => ({
        tenantId,
        ...order,
        firstSentAt: lines.reduce<Date | null>(
          (first, l) => (first === null || l.sentAt < first ? l.sentAt : first),
          null,
        ),
      })),
    });
    const lines = facts.flatMap((order) =>
      order.lines.map((line) => ({
        tenantId,
        locationId: order.locationId,
        orderId: order.orderId,
        ...line,
      })),
    );
    if (lines.length > 0) await tx.reportLineFact.createMany({ data: lines });
  }

  /** Recomputes these bookings; the rows of bookings that no longer exist are removed. */
  async bookings(reservationIds: readonly string[], tx: TenantTransactionClient): Promise<void> {
    const ids = [...new Set(reservationIds)].sort();
    if (ids.length === 0) return;
    const { tenantId } = this.tenantContext.require();
    await lock(tx, 'reservation', ids);
    const facts = await this.reservations.reservationFacts(ids, asTenantDb(tx));
    await tx.reportReservationFact.deleteMany({ where: { reservationId: { in: ids } } });
    if (facts.length === 0) return;
    await tx.reportReservationFact.createMany({ data: facts.map((f) => ({ tenantId, ...f })) });
  }
}

/** In id order, so two overlapping batches can't wait on each other. */
async function lock(
  tx: TenantTransactionClient,
  kind: 'order' | 'reservation',
  sortedIds: readonly string[],
): Promise<void> {
  for (const id of sortedIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reports.${kind}:${id}`}, 0))`;
  }
}
