import { Injectable } from '@nestjs/common';
import type { EventPayload } from '@durby/shared';
import { EntitlementService } from '../../platform/config/entitlements';
import { OnEvent, type OutboxEvent } from '../../platform/outbox';
import type { TenantTransactionClient } from '../../platform/tenancy';
import { ReportsProjection } from './projection.service';

type OrderEvent =
  'pos.order.opened' | 'pos.order.closed' | 'pos.order.updated' | 'pos.kitchen_ticket.created';

type ReservationEvent =
  | 'reservations.reservation.created'
  | 'reservations.reservation.updated'
  | 'reservations.reservation.status_changed';

/**
 * Feeds the read model from the till and the bookings (ADR 0081). Organizations without `reports` are skipped;
 * switching it on later needs a rebuild.
 */
@Injectable()
export class ReportsProjectionHandler {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly projection: ReportsProjection,
  ) {}

  @OnEvent('pos.order.opened', { handler: 'reports.projectOrderOpened' })
  orderOpened(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.order(event, tx);
  }

  @OnEvent('pos.order.closed', { handler: 'reports.projectOrderClosed' })
  orderClosed(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.order(event, tx);
  }

  @OnEvent('pos.order.updated', { handler: 'reports.projectOrderUpdated' })
  orderUpdated(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.order(event, tx);
  }

  @OnEvent('pos.kitchen_ticket.created', { handler: 'reports.projectTicket' })
  ticketCreated(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.order(event, tx);
  }

  @OnEvent('reservations.reservation.created', { handler: 'reports.projectReservationCreated' })
  reservationCreated(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.reservation(event, tx);
  }

  @OnEvent('reservations.reservation.updated', { handler: 'reports.projectReservationUpdated' })
  reservationUpdated(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.reservation(event, tx);
  }

  @OnEvent('reservations.reservation.status_changed', {
    handler: 'reports.projectReservationStatus',
  })
  reservationStatus(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.reservation(event, tx);
  }

  private async order(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    if (!(await this.entitlements.isEnabled('reports', tx))) return;
    const { orderId } = event.payload as EventPayload<OrderEvent>;
    await this.projection.order(orderId, tx);
  }

  private async reservation(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    if (!(await this.entitlements.isEnabled('reports', tx))) return;
    const { reservationId } = event.payload as EventPayload<ReservationEvent>;
    await this.projection.bookings([reservationId], tx);
  }
}
