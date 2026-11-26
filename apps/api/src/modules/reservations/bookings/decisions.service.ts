import { Inject, Injectable } from '@nestjs/common';
import type { AcceptReservationRequest, Reservation, ReservationStatus } from '@durby/shared';
import { auditActor, AuditService } from '../../../platform/audit';
import { Clock } from '../../../platform/auth';
import { IdempotencyService } from '../../../platform/idempotency';
import { OutboxService } from '../../../platform/outbox';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { evaluateBooking } from '../availability/engine';
import { reservationErrors } from '../reservations-errors';
import {
  BookingsService,
  exclusive,
  insertTables,
  payloadOf,
  problemError,
  read,
  type ReservationRow,
  reservationSnapshot,
} from './bookings.service';
import { shortLockWaits } from './busy';
import { appendChange, lock } from './status.service';

type Decision = 'accept' | 'confirm' | 'decline';

const FROM: Record<Decision, readonly ReservationStatus[]> = {
  accept: ['requested'],
  confirm: ['pending'],
  decline: ['requested', 'pending'],
};

/**
 * The restaurant's answer to online bookings it hasn't taken yet (docs/modules/reservations.md → Requests and pending
 * bookings, R2.3b): accept a larger party's request (tables allocated now, checked like any booking), confirm a pending
 * booking (its tables are already held), or decline either (a pending booking frees its tables by the table trigger).
 */
@Injectable()
export class BookingDecisionsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly bookings: BookingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
  ) {}

  accept(id: string, body: AcceptReservationRequest): Promise<Reservation> {
    return this.decide(id, 'accept', async (tx, before, tenantId) => {
      const now = this.clock.now();
      const { input } = await this.bookings.load(
        tx,
        before.locationId,
        before.startsAt,
        before.partySize,
        now,
        before.id,
        before.endsAt,
      );
      // Staff decide: the engine's best fit or the chosen tables; rules like pacing don't stop an accept.
      const verdict = evaluateBooking(input, {
        start: before.startsAt,
        end: before.endsAt,
        ...(body.tableIds && { tableIds: [...body.tableIds].sort() }),
      });
      if (!verdict.ok) throw problemError(verdict.problem);
      await tx.reservation.update({ where: { id: before.id }, data: { status: 'booked' } });
      await insertTables(
        tx,
        tenantId,
        before.id,
        before.locationId,
        verdict.tableIds,
        before.startsAt,
        before.endsAt,
      );
      return 'booked';
    });
  }

  confirm(id: string): Promise<Reservation> {
    return this.decide(id, 'confirm', async (tx, before) => {
      await tx.reservation.update({ where: { id: before.id }, data: { status: 'booked' } });
      return 'booked';
    });
  }

  decline(id: string): Promise<Reservation> {
    return this.decide(id, 'decline', async (tx, before) => {
      await tx.reservation.update({ where: { id: before.id }, data: { status: 'declined' } });
      return 'declined';
    });
  }

  private decide(
    id: string,
    decision: Decision,
    apply: (
      tx: TenantTransactionClient,
      before: ReservationRow,
      tenantId: string,
    ) => Promise<ReservationStatus>,
  ): Promise<Reservation> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      await this.bookings.manageable(id, tx);
      await lock(tx, id);
      const before = await read(tx, id);
      if (!FROM[decision].includes(before.status)) {
        throw reservationErrors.invalidTransition({ from: before.status });
      }
      const to = await exclusive(() => apply(tx, before, tenantId));
      await appendChange(tx, tenantId, { userId }, before, to, null);
      const after = await read(tx, id);
      await this.audit.record(tx, {
        action: 'reservations.reservation.status_changed',
        actor: auditActor.user(userId),
        entityId: id,
        before: reservationSnapshot(before),
        after: reservationSnapshot(after),
      });
      await this.outbox.add(tx, {
        type: 'reservations.reservation.status_changed',
        payload: payloadOf(after),
      });
      const response = await this.bookings.respondOne(tx, after);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }
}
