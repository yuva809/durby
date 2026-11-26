import { Injectable } from '@nestjs/common';
import type { EventPayload } from '@durby/shared';
import { auditActor, AuditService } from '../../../platform/audit';
import { OnEvent, type OutboxEvent, OutboxService } from '../../../platform/outbox';
import { TenantContext, type TenantTransactionClient } from '../../../platform/tenancy';
import { payloadOf, read, reservationSnapshot } from './bookings.service';

/**
 * A pending online booking nobody confirmed in time expires (R2.3b): `pending → expired`, its tables free again by the
 * table trigger. Written delayed when the booking was made (R2.0). Does nothing when the booking was confirmed,
 * declined or cancelled meanwhile, and nothing on a redelivery.
 */
@Injectable()
export class PendingExpiryHandler {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  @OnEvent('reservations.pending.expiry_due', { handler: 'reservations.expirePending' })
  async expire(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    const { reservationId } = event.payload as EventPayload<'reservations.pending.expiry_due'>;
    const { tenantId } = this.tenantContext.require();
    await tx.$executeRaw`SELECT 1 FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
    const found = await tx.reservation.findUnique({
      where: { id: reservationId },
      select: { status: true },
    });
    if (found?.status !== 'pending') return;
    const before = await read(tx, reservationId);
    await tx.reservation.update({ where: { id: reservationId }, data: { status: 'expired' } });
    await tx.reservationStatusChange.create({
      data: {
        tenantId,
        reservationId,
        fromStatus: 'pending',
        toStatus: 'expired',
        actorKind: 'system',
        previousStartsAt: before.startsAt,
        previousEndsAt: before.endsAt,
        previousTableIds: before.tables.map((t) => t.tableId),
      },
    });
    const after = await read(tx, reservationId);
    await this.audit.record(tx, {
      action: 'reservations.reservation.status_changed',
      actor: auditActor.system('job.outbox'),
      entityId: reservationId,
      before: reservationSnapshot(before),
      after: reservationSnapshot(after),
    });
    await this.outbox.add(tx, {
      type: 'reservations.reservation.status_changed',
      payload: payloadOf(after),
    });
  }
}
