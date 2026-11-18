import { Injectable } from '@nestjs/common';
import type { EventPayload } from '@durby/shared';
import { OnEvent, type OutboxEvent } from '../../../platform/outbox';
import { RealtimePublisher } from '../../../platform/realtime';

type ReservationEvent =
  | 'reservations.reservation.created'
  | 'reservations.reservation.updated'
  | 'reservations.reservation.status_changed';

/**
 * Tells open /host, /reservations and /service pages at the booking's location to reload (ADR 0044
 * §3). Runs only for committed events; a redelivery publishes again, which costs one extra reload.
 */
@Injectable()
export class ReservationsRealtimeHandler {
  constructor(private readonly realtime: RealtimePublisher) {}

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

  private publish(event: OutboxEvent): Promise<void> {
    const payload = event.payload as EventPayload<ReservationEvent>;
    return this.realtime.publish(payload.locationId, 'reservations', [payload.reservationId]);
  }
}
