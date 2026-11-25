import { Injectable } from '@nestjs/common';
import type { EventPayload } from '@durby/shared';
import { EntitlementService } from '../../../platform/config/entitlements';
import { OnEvent, type OutboxEvent } from '../../../platform/outbox';
import { RealtimePublisher } from '../../../platform/realtime';
import type { TenantTransactionClient } from '../../../platform/tenancy';

type ReservationEvent =
  | 'reservations.reservation.created'
  | 'reservations.reservation.updated'
  | 'reservations.reservation.status_changed';

type TillEvent = 'pos.order.opened' | 'pos.order.closed' | 'pos.order.updated';

/**
 * Tells open /host, /reservations and /service pages at the booking's location to reload (ADR 0044
 * §3). Runs only for committed events; a redelivery publishes again, which costs one extra reload. Till orders too: they
 * occupy tables on /host, and the Host role may not open the till's own stream. No ids then (they are pos's).
 */
@Injectable()
export class ReservationsRealtimeHandler {
  constructor(
    private readonly realtime: RealtimePublisher,
    private readonly entitlements: EntitlementService,
  ) {}

  @OnEvent('reservations.reservation.created', { handler: 'reservations.publishCreated' })
  created(event: OutboxEvent): Promise<void> {
    return this.publish(event);
  }

  @OnEvent('reservations.reservation.updated', { handler: 'reservations.publishUpdated' })
  updated(event: OutboxEvent): Promise<void> {
    return this.publish(event);
  }

  @OnEvent('reservations.reservation.status_changed', {
    handler: 'reservations.publishStatusChanged',
  })
  statusChanged(event: OutboxEvent): Promise<void> {
    return this.publish(event);
  }

  @OnEvent('pos.order.opened', { handler: 'reservations.publishTillOpened' })
  tillOpened(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.till(event, tx);
  }

  @OnEvent('pos.order.closed', { handler: 'reservations.publishTillClosed' })
  tillClosed(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.till(event, tx);
  }

  @OnEvent('pos.order.updated', { handler: 'reservations.publishTillUpdated' })
  tillUpdated(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.till(event, tx);
  }

  private async till(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    if (!(await this.entitlements.isEnabled('reservations', tx))) return;
    const payload = event.payload as EventPayload<TillEvent>;
    await this.realtime.publish(payload.locationId, 'reservations', []);
  }

  private publish(event: OutboxEvent): Promise<void> {
    const payload = event.payload as EventPayload<ReservationEvent>;
    return this.realtime.publish(payload.locationId, 'reservations', [payload.reservationId]);
  }
}
