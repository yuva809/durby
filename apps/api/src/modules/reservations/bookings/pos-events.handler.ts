import { Injectable, Logger } from '@nestjs/common';
import type { EventPayload } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../../platform/audit';
import { EntitlementService } from '../../../platform/config/entitlements';
import { SettingsService } from '../../../platform/config/settings';
import { OnEvent, type OutboxEvent, OutboxService } from '../../../platform/outbox';
import { TenantContext, type TenantTransactionClient } from '../../../platform/tenancy';
import { PosFloorReader } from '../../pos';
import { evaluateBooking } from '../availability/engine';
import { BookingsService, payloadOf, read, type ReservationRow } from './bookings.service';
import { isPartyOrder } from './status';
import { appendChange, lock } from './status.service';

/**
 * Reservations reacting to the till (docs/modules/reservations.md → R1.7): a pos order opened on a
 * table seats the booking expected there (restaurants without a host), and closing it finishes the
 * booking. Both run in the outbox's transaction as the system (`job.outbox`), record the order on
 * the status change, and ignore an event when the booking changed after it (a host undid it, or a
 * late redelivery). pos only emits the events; it never imports reservations.
 */
@Injectable()
export class PosEventsHandler {
  private readonly logger = new Logger(PosEventsHandler.name);

  constructor(
    private readonly tenantContext: TenantContext,
    private readonly entitlements: EntitlementService,
    private readonly settings: SettingsService,
    private readonly bookings: BookingsService,
    private readonly pos: PosFloorReader,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Seats the one booked or arrived booking on that table whose start is within ±window of the
   * order's opening. None or several: nothing (the host decides).
   */
  @OnEvent('pos.order.opened', { handler: 'reservations.seatOnOrderOpened' })
  async seatOnOrderOpened(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    if (!(await this.entitlements.isEnabled('reservations', tx))) return;
    const payload = event.payload as EventPayload<'pos.order.opened'>;
    const openedAt = new Date(payload.openedAt);
    const window = await this.windowAt(payload.locationId, tx);
    const candidates = await tx.reservation.findMany({
      where: {
        locationId: payload.locationId,
        status: { in: ['booked', 'arrived'] },
        tables: { some: { tableId: payload.tableId } },
        startsAt: {
          gte: new Date(openedAt.getTime() - window * 60_000),
          lte: new Date(openedAt.getTime() + window * 60_000),
        },
      },
      select: { id: true },
    });
    if (candidates.length !== 1) {
      if (candidates.length > 1) this.warn('several bookings match an opened order', event);
      return;
    }
    const { id } = candidates[0]!;
    await lock(tx, id);
    const current = await read(tx, id);
    if (current.status !== 'booked' && current.status !== 'arrived') return;
    if (await changedSince(tx, id, event.id)) return;

    // An early party starts now (the order's opening) and keeps its length, like a manual seat.
    let start = current.startsAt;
    let end = current.endsAt;
    if (openedAt < start) {
      end = new Date(openedAt.getTime() + (end.getTime() - start.getTime()));
      start = openedAt;
    }
    const tableIds = current.tables.map((t) => t.tableId);
    if (!(await this.tablesFree(tx, current, start, end, tableIds, openedAt, window))) {
      this.warn('auto-seat skipped: tables not free', event);
      return;
    }
    await tx.reservation.update({
      where: { id },
      data: {
        status: 'seated',
        seatedAt: openedAt,
        ...(start.getTime() !== current.startsAt.getTime() && { startsAt: start, endsAt: end }),
      },
    });
    await this.record(tx, current, 'seated', payload.orderId);
  }

  /**
   * Finishes the seated booking holding that table when its own order (opened within ±window of
   * the booking's start) closes and no other table of the booking still has an open order.
   */
  @OnEvent('pos.order.closed', { handler: 'reservations.finishOnOrderClosed' })
  async finishOnOrderClosed(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    if (!(await this.entitlements.isEnabled('reservations', tx))) return;
    const payload = event.payload as EventPayload<'pos.order.closed'>;
    const seated = await tx.reservation.findMany({
      where: {
        locationId: payload.locationId,
        status: 'seated',
        tables: { some: { tableId: payload.tableId } },
      },
      select: { id: true },
    });
    if (seated.length !== 1) {
      if (seated.length > 1)
        this.warn('several seated bookings hold a closed order’s table', event);
      return;
    }
    const { id } = seated[0]!;
    await lock(tx, id);
    const current = await read(tx, id);
    if (current.status !== 'seated') return;
    if (await changedSince(tx, id, event.id)) return;

    // The previous party's late close never finishes this booking: the order must be its own.
    const order = await this.pos.order(payload.orderId, tx);
    if (!order) return;
    const window = await this.windowAt(payload.locationId, tx);
    if (!isPartyOrder(order.openedAt, await startBeforeSeating(tx, current), window)) return;
    // Separate bills: the last of the booking's orders to close finishes it.
    const tableIds = current.tables.map((t) => t.tableId);
    const open = await this.pos.openOrders(payload.locationId, tx);
    if (open.some((o) => tableIds.includes(o.tableId))) return;

    const closedAt = order.closedAt ?? event.occurredAt;
    await tx.reservation.update({
      where: { id },
      data: {
        status: 'finished',
        finishedAt: closedAt,
        endsAt: new Date(Math.max(closedAt.getTime(), current.startsAt.getTime() + 60_000)),
      },
    });
    await tx.reservationGuest.update({
      where: { id: current.guest.id },
      data: { lastVisitAt: closedAt },
    });
    await this.record(tx, current, 'finished', payload.orderId);
  }

  /** The tables at `[start, end)` without the booking and without its own till order. */
  private async tablesFree(
    tx: TenantTransactionClient,
    current: ReservationRow,
    start: Date,
    end: Date,
    tableIds: string[],
    now: Date,
    window: number,
  ): Promise<boolean> {
    const { input } = await this.bookings.load(
      tx,
      current.locationId,
      start,
      current.partySize,
      now,
      current.id,
      end,
    );
    const verdict = evaluateBooking(
      {
        ...input,
        openOrders: input.openOrders.filter(
          (o) =>
            !(tableIds.includes(o.tableId) && isPartyOrder(o.openedAt, current.startsAt, window)),
        ),
      },
      { start, end, tableIds, walkIn: current.source === 'walk_in' },
    );
    return verdict.ok;
  }

  /** Status change (system, with the till order), audit and event. */
  private async record(
    tx: TenantTransactionClient,
    before: ReservationRow,
    to: 'seated' | 'finished',
    sourceOrderId: string,
  ): Promise<void> {
    const { tenantId } = this.tenantContext.require();
    await appendChange(tx, tenantId, { sourceOrderId }, before, to, null);
    const after = await read(tx, before.id);
    await this.audit.record(tx, {
      action: 'reservations.reservation.status_changed',
      actor: auditActor.system('job.outbox'),
      entityId: before.id,
      before: snapshot('reservation', fields(before)),
      after: snapshot('reservation', { ...fields(after), sourceOrderId }),
    });
    await this.outbox.add(tx, {
      type: 'reservations.reservation.status_changed',
      payload: payloadOf(after),
    });
  }

  private async windowAt(locationId: string, tx: TenantTransactionClient): Promise<number> {
    return this.settings.get('reservations.orderMatchWindowMinutes', { locationId }, tx);
  }

  private warn(message: string, event: OutboxEvent): void {
    this.logger.warn({ tenantId: event.tenantId, eventId: event.id, type: event.type }, message);
  }
}

/**
 * A change after the event (an undo, a host action): the event is stale, the host is in charge.
 * Compared by id, not time: both ids are UUID v7 from the database's clock, while `created_at` is
 * set by the app's (another machine's) clock and may be skewed against the event's `occurred_at`.
 */
async function changedSince(
  tx: TenantTransactionClient,
  reservationId: string,
  eventId: string,
): Promise<boolean> {
  const count = await tx.reservationStatusChange.count({
    where: { reservationId, id: { gt: eventId } },
  });
  return count > 0;
}

/** The booking's start before it was seated (an early seat moves it), to match its order against. */
async function startBeforeSeating(
  tx: TenantTransactionClient,
  current: ReservationRow,
): Promise<Date> {
  const seat = await tx.reservationStatusChange.findFirst({
    where: { reservationId: current.id, toStatus: 'seated' },
    orderBy: { id: 'desc' },
    select: { previousStartsAt: true },
  });
  return seat?.previousStartsAt ?? current.startsAt;
}

const fields = (row: ReservationRow) => ({
  id: row.id,
  number: row.number,
  locationId: row.locationId,
  partySize: row.partySize,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  status: row.status,
  source: row.source,
  tableIds: row.tables.map((t) => t.tableId),
});
