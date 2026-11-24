import { Inject, Injectable } from '@nestjs/common';
import { auditActor, AuditService } from '../../platform/audit';
import { EntitlementService } from '../../platform/config/entitlements';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { PosSalesReader } from '../pos';
import { ReservationsReader } from '../reservations';
import { ReportsProjection } from './projection.service';

/** Orders or bookings per transaction. */
export const REBUILD_BATCH = 100;

/** The rebuild's actor; audit rows name `cli.reports`. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export class ReportsRebuildError extends Error {
  readonly code = 'reports.rebuild_input';
}

export interface RebuildCounts {
  orders: number;
  reservations: number;
  /** Orders and bookings in the read model that no longer exist. */
  removed: number;
}

type Ids = (
  page: { after?: string | undefined; take: number },
  tx: TenantTransactionClient,
) => Promise<string[]>;

/**
 * `reports rebuild` (ADR 0081): recomputes one organization's facts with the handlers' own code, in batches, each in its
 * own transaction. Safe while the till is in use: a batch and a handler take the same lock per order.
 */
@Injectable()
export class ReportsRebuild {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly sales: PosSalesReader,
    private readonly reservations: ReservationsReader,
    private readonly projection: ReportsProjection,
  ) {}

  /** `from`: only orders opened and bookings starting from then on. */
  async rebuild(organizationId: string, from?: Date): Promise<RebuildCounts> {
    const context = { tenantId: organizationId, userId: SYSTEM_USER_ID };
    return this.tenantContext.run(context, async () => {
      // Also what an unknown organization answers: it has no features.
      if (!(await this.entitlements.isEnabled('reports'))) {
        throw new ReportsRebuildError(`No organization ${organizationId} with the reports feature`);
      }
      const orders = await this.each(
        (page, tx) => this.sales.orderIds({ ...page, from }, asTenantDb(tx)),
        (ids, tx) => this.projection.orders(ids, tx),
      );
      const bookings = await this.each(
        (page, tx) => this.reservations.reservationIds({ ...page, from }, asTenantDb(tx)),
        (ids, tx) => this.projection.bookings(ids, tx),
      );
      // Facts whose order or booking is gone (a wiped organization's data, for example).
      const goneOrders = await this.each(
        async ({ after, take }, tx) =>
          (
            await tx.reportOrderFact.findMany({
              where: after ? { orderId: { gt: after } } : {},
              select: { orderId: true },
              orderBy: { orderId: 'asc' },
              take,
            })
          ).map((r) => r.orderId),
        async (ids, tx) => {
          const there = await this.sales.orderFacts(ids, asTenantDb(tx));
          const gone = without(
            ids,
            there.map((o) => o.orderId),
          );
          await this.projection.orders(gone, tx);
          return gone.length;
        },
      );
      const goneBookings = await this.each(
        async ({ after, take }, tx) =>
          (
            await tx.reportReservationFact.findMany({
              where: after ? { reservationId: { gt: after } } : {},
              select: { reservationId: true },
              orderBy: { reservationId: 'asc' },
              take,
            })
          ).map((r) => r.reservationId),
        async (ids, tx) => {
          const there = await this.reservations.reservationFacts(ids, asTenantDb(tx));
          const gone = without(
            ids,
            there.map((r) => r.reservationId),
          );
          await this.projection.bookings(gone, tx);
          return gone.length;
        },
      );
      await this.db.$transaction((tx) =>
        this.audit.record(tx, {
          action: 'reports.facts.rebuilt',
          actor: auditActor.system('cli.reports'),
          entityId: organizationId,
        }),
      );
      return {
        orders: orders.seen,
        reservations: bookings.seen,
        removed: goneOrders.counted + goneBookings.counted,
      };
    });
  }

  /** Pages through ids, each page read and handled in one transaction. */
  private async each(
    page: Ids,
    handle: (ids: string[], tx: TenantTransactionClient) => Promise<number | void>,
  ): Promise<{ seen: number; counted: number }> {
    let after: string | undefined;
    let seen = 0;
    let counted = 0;
    for (;;) {
      const ids = await this.db.$transaction(async (tx) => {
        const batch = await page({ after, take: REBUILD_BATCH }, tx);
        if (batch.length > 0) counted += (await handle(batch, tx)) ?? 0;
        return batch;
      });
      seen += ids.length;
      after = ids.at(-1);
      if (ids.length < REBUILD_BATCH) return { seen, counted };
    }
  }
}

function without(ids: readonly string[], there: readonly string[]): string[] {
  const known = new Set(there);
  return ids.filter((id) => !known.has(id));
}
