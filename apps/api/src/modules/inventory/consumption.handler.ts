import { Injectable, Logger } from '@nestjs/common';
import type { EventPayload } from '@durby/shared';
import { EntitlementService } from '../../platform/config/entitlements';
import { OnEvent, type OutboxEvent } from '../../platform/outbox';
import type { TenantTransactionClient } from '../../platform/tenancy';
import { StockService } from './stock.service';

/**
 * Inventory reacting to the till (docs/modules/inventory.md → Consumption, ADR 0028): each kitchen
 * or bar ticket books its dishes' ingredients. Runs in the outbox's transaction; organizations
 * without `inventory` are skipped. pos only emits the event; it never imports inventory.
 */
@Injectable()
export class ConsumptionHandler {
  private readonly logger = new Logger(ConsumptionHandler.name);

  constructor(
    private readonly entitlements: EntitlementService,
    private readonly stock: StockService,
  ) {}

  @OnEvent('pos.kitchen_ticket.created', { handler: 'inventory.consumeTicket' })
  async consumeTicket(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    if (!(await this.entitlements.isEnabled('inventory', tx))) return;
    const payload = event.payload as EventPayload<'pos.kitchen_ticket.created'>;
    const outcome = await this.stock.consumeTicket(tx, payload);
    if (outcome === 'no_warehouse') {
      this.logger.warn(
        { eventId: event.id, locationId: payload.locationId },
        'consumption skipped: the location has no warehouse',
      );
    }
  }
}
