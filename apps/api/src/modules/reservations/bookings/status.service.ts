import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type CreateWalkInRequest,
  MAX_BOOKING_MINUTES,
  MIN_WALK_IN_MINUTES,
  type Reservation,
  type ReservationStatus,
  type SeatReservationRequest,
  turnTimeFor,
} from '@durby/shared';
import { auditActor, AuditService } from '../../../platform/audit';
import { Clock } from '../../../platform/auth';
import { ApiError } from '../../../platform/http';
import { IdempotencyService } from '../../../platform/idempotency';
import { NumberingService } from '../../../platform/numbering';
import { OutboxService } from '../../../platform/outbox';
import { AccessService } from '../../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { evaluateBooking } from '../availability/engine';
import { reservationErrors } from '../reservations-errors';
import { shortLockWaits } from './busy';
import { readableLocation } from '../setup/table-rules.service';
import {
  assignNumber,
  BLOCKING_STATUSES,
  BookingsService,
  exclusive,
  guestDetails,
  insertTables,
  payloadOf,
  problemError,
  read,
  type ReservationRow,
  reservationSnapshot,
  temporaryNumber,
} from './bookings.service';
import { resolveGuest } from './guests';
import { isPartyOrder, type StatusAction, transition, undoable } from './status';

/** The timestamp each status sets, cleared again when that status is undone. */
export const STAMP: Partial<
  Record<ReservationStatus, 'arrivedAt' | 'seatedAt' | 'finishedAt' | 'noShowAt' | 'cancelledAt'>
> = {
  arrived: 'arrivedAt',
  seated: 'seatedAt',
  finished: 'finishedAt',
  no_show: 'noShowAt',
  cancelled: 'cancelledAt',
};

const isBlocking = (status: ReservationStatus) =>
  (BLOCKING_STATUSES as readonly string[]).includes(status);

/**
 * Status actions, undo and walk-ins (docs/modules/reservations.md → R1.6 bookings API, R1.6c).
 * Every change appends a status change recording the times and tables it replaced, so an undo
 * restores exactly them; seating and undoing back to a blocking status re-run the table checks.
 */
@Injectable()
export class BookingStatusService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly bookings: BookingsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
  ) {}

  async act(
    id: string,
    action: StatusAction,
    body: SeatReservationRequest = {},
  ): Promise<Reservation> {
    const { tenantId, userId } = this.tenantContext.require();
    const now = this.clock.now();

    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      const found = await this.bookings.manageable(id, tx);
      await lock(tx, id);
      const current = await read(tx, id);
      const step = transition(action, current, now);
      if (!step.ok) throw reservationErrors.invalidTransition({ from: step.from, to: step.to });

      let start = current.startsAt;
      let end = current.endsAt;
      const currentTables = current.tables.map((t) => t.tableId);
      let tableIds = currentTables;
      if (action === 'seat') {
        // Early: the party is here, so the booking starts now and keeps its length.
        if (now < start) {
          end = new Date(now.getTime() + (end.getTime() - start.getTime()));
          start = now;
        }
        tableIds = body.tableIds ? [...body.tableIds].sort() : currentTables;
        await this.checkTables(tx, current, found.locationId, start, end, tableIds, now, {
          ownTables: !body.tableIds,
          partyStart: current.startsAt,
        });
      }
      if (action === 'finish') {
        // Frees the rest of the period at once.
        end = new Date(Math.max(now.getTime(), start.getTime() + 60_000));
      }

      const stamp = STAMP[step.to];
      await exclusive(() =>
        tx.reservation.update({
          where: { id },
          data: {
            status: step.to,
            ...(start.getTime() !== current.startsAt.getTime() && { startsAt: start }),
            ...(end.getTime() !== current.endsAt.getTime() && { endsAt: end }),
            ...(stamp && { [stamp]: now }),
          },
        }),
      );
      await replaceTables(tx, tenantId, id, found.locationId, currentTables, tableIds, start, end);
      if (action === 'finish') {
        await tx.reservationGuest.update({
          where: { id: current.guest.id },
          data: { lastVisitAt: now },
        });
      }
      await appendChange(tx, tenantId, { userId }, current, step.to, null);
      return this.finish(tx, userId, current, 'reservations.reservation.status_changed');
    });
  }

  async undo(id: string, changeId: string): Promise<Reservation> {
    const { tenantId, userId } = this.tenantContext.require();
    const now = this.clock.now();

    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      const found = await this.bookings.manageable(id, tx);
      await lock(tx, id);
      const current = await read(tx, id);
      const latest = await tx.reservationStatusChange.findFirst({
        where: { reservationId: id },
        // The same "latest" as lastChangeId: ids are UUID v7.
        orderBy: { id: 'desc' },
      });
      if (!latest || !undoable(latest, changeId, now)) throw reservationErrors.undoExpired();

      const to = latest.fromStatus!;
      const start = latest.previousStartsAt ?? current.startsAt;
      const end = latest.previousEndsAt ?? current.endsAt;
      const currentTables = current.tables.map((t) => t.tableId);
      const tableIds = latest.previousTableIds.length
        ? [...latest.previousTableIds].sort()
        : currentTables;
      // Back to holding tables: they may have been taken or occupied meanwhile.
      if (isBlocking(to)) {
        await this.checkTables(tx, current, found.locationId, start, end, tableIds, now, {
          ownTables: true,
          partyStart: start,
        });
      }
      const undoneStamp = STAMP[current.status];
      await exclusive(() =>
        tx.reservation.update({
          where: { id },
          data: {
            status: to,
            startsAt: start,
            endsAt: end,
            ...(undoneStamp && { [undoneStamp]: null }),
          },
        }),
      );
      await replaceTables(tx, tenantId, id, found.locationId, currentTables, tableIds, start, end);
      await appendChange(tx, tenantId, { userId }, current, to, latest.id);
      return this.finish(tx, userId, current, 'reservations.reservation.status_undone');
    });
  }

  async walkIn(body: CreateWalkInRequest): Promise<Reservation> {
    const { tenantId, userId } = this.tenantContext.require();
    const now = this.clock.now();

    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      await readableLocation(tx, this.access, body.locationId);
      await this.access.assert('reservations.bookings.create', { locationId: body.locationId });
      if (body.endsAt) {
        const minutes = (Date.parse(body.endsAt) - now.getTime()) / 60_000;
        if (minutes < MIN_WALK_IN_MINUTES || minutes > MAX_BOOKING_MINUTES) {
          throw new ApiError(HttpStatus.BAD_REQUEST, 'validation.failed', 'Invalid walk-in end.', {
            issues: [
              {
                path: ['endsAt'],
                code: 'custom',
                message: `endsAt must be ${MIN_WALK_IN_MINUTES} min to ${MAX_BOOKING_MINUTES} min from now`,
              },
            ],
          });
        }
      }
      const { input, settings } = await this.bookings.load(
        tx,
        body.locationId,
        now,
        body.partySize,
        now,
      );
      const start = now;
      const end = body.endsAt
        ? new Date(body.endsAt)
        : new Date(now.getTime() + turnTimeFor(body.partySize, input.settings.turnTimes) * 60_000);
      // The party is here: tables must be free, the booking rules don't apply.
      const verdict = evaluateBooking(input, { start, end, tableIds: body.tableIds, walkIn: true });
      if (!verdict.ok) throw problemError(verdict.problem, verdict.nextStartsAt);

      const guest = guestDetails(
        { ...(body.name && { name: body.name }), ...(body.phone && { phone: body.phone }) },
        settings,
      );
      const guestId = await resolveGuest(tx, tenantId, {
        ...guest,
        locale: settings.get('locale')?.value as string,
      });
      const { id } = await tx.reservation.create({
        data: {
          tenantId,
          locationId: body.locationId,
          number: temporaryNumber(),
          guestId,
          partySize: body.partySize,
          startsAt: start,
          endsAt: end,
          status: 'seated',
          source: 'walk_in',
          seatedAt: now,
          createdByUserId: userId,
        },
        select: { id: true },
      });
      await insertTables(tx, tenantId, id, body.locationId, verdict.tableIds, start, end);
      await assignNumber(tx, this.numbering, id);
      await tx.reservationStatusChange.create({
        data: {
          tenantId,
          reservationId: id,
          fromStatus: null,
          toStatus: 'seated',
          actorUserId: userId,
          actorKind: 'user',
        },
      });
      const row = await read(tx, id);
      await this.audit.record(tx, {
        action: 'reservations.reservation.created',
        actor: auditActor.user(userId),
        entityId: id,
        after: reservationSnapshot(row),
      });
      await this.outbox.add(tx, {
        type: 'reservations.reservation.created',
        payload: payloadOf(row),
      });
      const response = await this.bookings.respondOne(tx, row);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /**
   * The table checks for `tableIds` at `[start, end)` without the booking itself: fit, open pos
   * order, overrunning party, other bookings. Never the rules: the party is here. `ownTables`: the
   * booking's own (not the caller's choice), so one pos archived since is a 409, not a 404.
   * `partyStart`: the booking's start that its own till order is matched against.
   */
  private async checkTables(
    tx: TenantTransactionClient,
    current: ReservationRow,
    locationId: string,
    start: Date,
    end: Date,
    tableIds: string[],
    now: Date,
    opts: { ownTables: boolean; partyStart: Date },
  ): Promise<void> {
    const { input: loaded, settings } = await this.bookings.load(
      tx,
      locationId,
      start,
      current.partySize,
      now,
      current.id,
      end,
    );
    // The party's own till order (opened within ±window of its start) doesn't occupy its table.
    const window = settings.get('reservations.orderMatchWindowMinutes')?.value as number;
    const input = {
      ...loaded,
      openOrders: loaded.openOrders.filter(
        (o) => !(tableIds.includes(o.tableId) && isPartyOrder(o.openedAt, opts.partyStart, window)),
      ),
    };
    const verdict = evaluateBooking(input, {
      start,
      end,
      tableIds,
      walkIn: current.source === 'walk_in',
    });
    if (!verdict.ok) {
      if (verdict.problem === 'table_not_found' && opts.ownTables) {
        const inService = new Set(input.tables.map((t) => t.id));
        throw reservationErrors.tableNotInService(tableIds.filter((t) => !inService.has(t)));
      }
      throw problemError(verdict.problem);
    }
  }

  /** Audit, event and the idempotent answer of a status change. */
  private async finish(
    tx: TenantTransactionClient,
    userId: string,
    before: ReservationRow,
    action: 'reservations.reservation.status_changed' | 'reservations.reservation.status_undone',
  ): Promise<Reservation> {
    const after = await read(tx, before.id);
    await this.audit.record(tx, {
      action,
      actor: auditActor.user(userId),
      entityId: before.id,
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
  }
}

/** One writer per booking at a time. */
export async function lock(tx: TenantTransactionClient, id: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM reservations WHERE id = ${id}::uuid FOR UPDATE`;
}

/**
 * Appends a status change recording what it replaced (for undo). `actor`: a user, or the system
 * with the till order that caused it (auto-seat, finish on close).
 */
export async function appendChange(
  tx: TenantTransactionClient,
  tenantId: string,
  actor: { userId: string } | { sourceOrderId: string },
  before: ReservationRow,
  to: ReservationStatus,
  undoesId: string | null,
): Promise<void> {
  await tx.reservationStatusChange.create({
    data: {
      tenantId,
      reservationId: before.id,
      fromStatus: before.status,
      toStatus: to,
      undoesId,
      ...('userId' in actor
        ? { actorUserId: actor.userId, actorKind: 'user' }
        : { actorKind: 'system', sourceOrderId: actor.sourceOrderId }),
      previousStartsAt: before.startsAt,
      previousEndsAt: before.endsAt,
      previousTableIds: before.tables.map((t) => t.tableId),
    },
  });
}

/** New table rows when the tables change (after the reservation's status and times are set). */
async function replaceTables(
  tx: TenantTransactionClient,
  tenantId: string,
  id: string,
  locationId: string,
  currentTables: string[],
  tableIds: string[],
  start: Date,
  end: Date,
): Promise<void> {
  if (tableIds.join() === currentTables.join()) return;
  await tx.reservationTable.deleteMany({ where: { reservationId: id } });
  await insertTables(tx, tenantId, id, locationId, tableIds, start, end);
}
