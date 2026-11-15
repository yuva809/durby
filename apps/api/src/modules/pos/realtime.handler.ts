import { Injectable } from '@nestjs/common';
import type { EventPayload } from '@durby/shared';
import { OnEvent, type OutboxEvent } from '../../platform/outbox';
import { RealtimePublisher } from '../../platform/realtime';

/**
 * Tells open /service pages at the order's location to reload the floor (ADR 0044 §3): an order
 * opened or closed, a ticket sent or voided. Runs only for committed events.
 */
@Injectable()
export class PosRealtimeHandler {
  constructor(private readonly realtime: RealtimePublisher) {}

  @OnEvent('pos.order.opened', { handler: 'pos.publishOrderOpened' })
  orderOpened(event: OutboxEvent): Promise<void> {
    const payload = event.payload as EventPayload<'pos.order.opened'>;
    return this.realtime.publish(payload.locationId, 'pos.floor', [payload.orderId]);
  }

  @OnEvent('pos.order.closed', { handler: 'pos.publishOrderClosed' })
  orderClosed(event: OutboxEvent): Promise<void> {
    const payload = event.payload as EventPayload<'pos.order.closed'>;
    return this.realtime.publish(payload.locationId, 'pos.floor', [payload.orderId]);
  }

  @OnEvent('pos.kitchen_ticket.created', { handler: 'pos.publishKitchenTicket' })
  kitchenTicket(event: OutboxEvent): Promise<void> {
    const payload = event.payload as EventPayload<'pos.kitchen_ticket.created'>;
    return this.realtime.publish(payload.locationId, 'pos.floor', [payload.orderId]);
  }
}
