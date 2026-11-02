import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  asCountryCode,
  type CreateReservationRequest,
  MAX_BOOKING_MINUTES,
  normalisePhone,
  type Reservation,
  type ReservationDetail,
  type ReservationGuestInput,
  type ReservationsListQuery,
  turnTimeFor,
  type UpdateReservationRequest,
  zonedDayBounds,
  zonedParts,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../../platform/audit';
import { Clock } from '../../../platform/auth';
import { type ResolvedSettings, SettingsService } from '../../../platform/config/settings';
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
import { evaluateBooking, type RuleBreach } from '../availability/engine';
import { AvailabilityLoader } from '../availability/loader';
import { reservationErrors } from '../reservations-errors';
import { shortLockWaits } from './busy';
import { readableLocation } from '../setup/table-rules.service';
import { correctGuest, type GuestDetails, resolveGuest } from './guests';

const MANAGE = 'reservations.bookings.manage';
const READ = 'reservations.bookings.read';
/** How far back a booking may start (Q4): parties already here are walk-ins. */
const PAST_GRACE_MS = 15 * 60_000;
/** Blocking statuses hold their tables (exclusion constraint, covers). */
export const BLOCKING_STATUSES = ['pending', 'booked', 'arrived', 'seated'] as const;
const EDITABLE = ['pending', 'booked', 'arrived', 'seated'] as const;

const RESERVATION_SELECT = {
  id: true,
  number: true,
  locationId: true,
  status: true,
  source: true,
  partySize: true,
  startsAt: true,
  endsAt: true,
  guestNote: true,
  staffNote: true,
  createdAt: true,
  guest: { select: { id: true, name: true, email: true, phone: true, locale: true } },
  tables: { select: { tableId: true }, orderBy: { tableId: 'asc' } },
  // The latest change: what an undo would revert.
  // Ids are UUID v7: newest id = newest change.
  changes: { select: { id: true }, orderBy: { id: 'desc' }, take: 1 },
} as const;

export type ReservationRow = {
  id: string;
  number: string;
  locationId: string;
  status: Reservation['status'];
  source: Reservation['source'];
  partySize: number;
  startsAt: Date;
  endsAt: Date;
  guestNote: string | null;
  staffNote: string | null;
  createdAt: Date;
  guest: Reservation['guest'];
  tables: { tableId: string }[];
  changes: { id: string }[];
};

/**
 * Staff bookings (docs/modules/reservations.md → R1.6 bookings API): create, list, get, move. Every
 * write runs the engine's checks for exactly that booking in its own transaction (the loader reads
 * through `tx`), then the exclusion constraint settles races (23P01 → table_unavailable).
 */
@Injectable()
export class BookingsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly loader: AvailabilityLoader,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
  ) {}

  async create(body: CreateReservationRequest): Promise<Reservation> {
    const { tenantId, userId } = this.tenantContext.require();
    const now = this.clock.now();
    const start = new Date(body.startsAt);

    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      await readableLocation(tx, this.access, body.locationId);
      await this.access.assert(MANAGE, { locationId: body.locationId });
      if (start.getTime() < now.getTime() - PAST_GRACE_MS) throw reservationErrors.startsInPast();
      const { input, settings } = await this.load(tx, body.locationId, start, body.partySize, now);
      const end = body.endsAt
        ? new Date(body.endsAt)
        : new Date(
            start.getTime() + turnTimeFor(body.partySize, input.settings.turnTimes) * 60_000,
          );
      const verdict = evaluateBooking(input, { start, end, tableIds: body.tableIds });
      if (!verdict.ok) throw problemError(verdict.problem);
      const overridden = breachesAllowed(verdict.breaches, body.force);

      const guest = guestDetails(body.guest, settings);
      const guestId = await resolveGuest(tx, tenantId, {
        ...guest,
        locale: guest.locale ?? (settings.get('locale')?.value as string),
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
          status: 'booked',
          source: 'staff',
          guestNote: body.guestNote ?? null,
          staffNote: body.staffNote ?? null,
          createdByUserId: userId,
        },
        select: { id: true },
      });
      await insertTables(tx, tenantId, id, body.locationId, verdict.tableIds, start, end);
      // Only once the tables are ours: concurrent losers (23P01) never queue on the counter lock,
      // which stays held until commit (ADR 0012: as late as possible).
      await assignNumber(tx, this.numbering, id);
      await tx.reservationStatusChange.create({
        data: {
          tenantId,
          reservationId: id,
          fromStatus: null,
          toStatus: 'booked',
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
      await this.recordOverride(tx, userId, row, overridden);
      await this.outbox.add(tx, {
        type: 'reservations.reservation.created',
        payload: payloadOf(row),
      });
      const response = toResponse(row);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  async update(id: string, body: UpdateReservationRequest): Promise<Reservation> {
    const { tenantId, userId } = this.tenantContext.require();
    const now = this.clock.now();

    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      const found = await this.manageable(id, tx);
      // One writer per booking at a time: no lost updates between two hosts.
      await tx.$executeRaw`SELECT 1 FROM reservations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await read(tx, id);
      if (!(EDITABLE as readonly string[]).includes(current.status)) {
        throw reservationErrors.invalidTransition({ from: current.status });
      }
      const start = body.startsAt ? new Date(body.startsAt) : current.startsAt;
      const length = current.endsAt.getTime() - current.startsAt.getTime();
      // Moving keeps the length unless an end is given.
      const end = body.endsAt ? new Date(body.endsAt) : new Date(start.getTime() + length);
      const partySize = body.partySize ?? current.partySize;
      const currentTables = current.tables.map((t) => t.tableId);
      const tableIds = body.tableIds ? [...body.tableIds].sort() : currentTables;
      if (
        end.getTime() <= start.getTime() ||
        end.getTime() - start.getTime() > MAX_BOOKING_MINUTES * 60_000
      ) {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'validation.failed', 'Invalid booking length.', {
          issues: [{ path: ['endsAt'], code: 'custom', message: 'endsAt must be after startsAt' }],
        });
      }
      const moved = start.getTime() !== current.startsAt.getTime();
      if (moved && start.getTime() < now.getTime() - PAST_GRACE_MS) {
        throw reservationErrors.startsInPast();
      }
      const timingChanged = moved || end.getTime() !== current.endsAt.getTime();
      const tablesChanged = tableIds.join() !== currentTables.join();
      const partyChanged = partySize !== current.partySize;

      let overridden: RuleBreach[] = [];
      let settings: ResolvedSettings | undefined;
      if (timingChanged || tablesChanged || partyChanged) {
        const loaded = await this.load(tx, found.locationId, start, partySize, now, id, end);
        const { input } = loaded;
        settings = loaded.settings;
        const verdict = evaluateBooking(input, {
          start,
          end,
          tableIds,
          walkIn: current.source === 'walk_in',
        });
        if (!verdict.ok) throw problemError(verdict.problem);
        // Rules apply to where and when the booking goes, not to a note or a guest edit.
        overridden = breachesAllowed(verdict.breaches, body.force);
      }

      let guestId = current.guest.id;
      if (body.guest) {
        settings ??= await this.settings.all({ locationId: found.locationId }, tx);
        guestId = await correctGuest(tx, current.guest.id, guestDetails(body.guest, settings));
      }

      const data = {
        ...(moved && { startsAt: start }),
        ...(end.getTime() !== current.endsAt.getTime() && { endsAt: end }),
        ...(partyChanged && { partySize }),
        ...(guestId !== current.guest.id && { guestId }),
        ...(body.guestNote !== undefined &&
          body.guestNote !== current.guestNote && { guestNote: body.guestNote }),
        ...(body.staffNote !== undefined &&
          body.staffNote !== current.staffNote && { staffNote: body.staffNote }),
      };
      if (Object.keys(data).length > 0) {
        // The sync trigger moves the table rows' period: an overlap fails here (23P01).
        await exclusive(() => tx.reservation.update({ where: { id }, data }));
      }
      if (tablesChanged) {
        await tx.reservationTable.deleteMany({ where: { reservationId: id } });
        await insertTables(tx, tenantId, id, found.locationId, tableIds, start, end);
      }
      const next = await read(tx, id);
      const before = reservationSnapshot(current);
      const after = reservationSnapshot(next);
      if (JSON.stringify(before) === JSON.stringify(after)) return toResponse(next);
      await this.audit.record(tx, {
        action: 'reservations.reservation.updated',
        actor: auditActor.user(userId),
        entityId: id,
        before,
        after,
      });
      await this.recordOverride(tx, userId, next, overridden);
      await this.outbox.add(tx, {
        type: 'reservations.reservation.updated',
        payload: payloadOf(next),
      });
      return toResponse(next);
    });
  }

  async get(id: string): Promise<ReservationDetail> {
    await this.readable(id);
    const row = await this.db.reservation.findUnique({ where: { id }, select: RESERVATION_SELECT });
    if (!row) throw reservationErrors.reservationNotFound();
    const changes = await this.db.reservationStatusChange.findMany({
      where: { reservationId: id },
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        undoesId: true,
        actorKind: true,
        sourceOrderId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      ...toResponse(row),
      history: changes.map((c) => ({
        id: c.id,
        fromStatus: c.fromStatus,
        toStatus: c.toStatus,
        undoesId: c.undoesId,
        actorKind: c.actorKind as 'user' | 'guest' | 'system',
        sourceOrderId: c.sourceOrderId,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  async list(query: ReservationsListQuery): Promise<Reservation[]> {
    await readableLocation(this.db, this.access, query.locationId);
    let from: Date;
    let to: Date;
    if (query.date) {
      const timeZone = await this.settings.get('timezone', { locationId: query.locationId });
      ({ start: from, end: to } = zonedDayBounds(query.date, timeZone));
    } else {
      from = new Date(query.from!);
      to = new Date(query.to!);
    }
    const rows = await this.db.reservation.findMany({
      where: {
        locationId: query.locationId,
        startsAt: { gte: from, lt: to },
        ...(query.status && { status: query.status }),
      },
      select: RESERVATION_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => toResponse(r));
  }

  /** The engine's input for the local date of `start`, read in `tx`. */
  async load(
    tx: TenantTransactionClient,
    locationId: string,
    start: Date,
    partySize: number,
    now: Date,
    excludeReservationId?: string,
    end?: Date,
  ) {
    // Resolved once for the local date and the engine (the location is known to exist).
    const resolved = await this.settings.all({ locationId }, tx);
    const timeZone = resolved.get('timezone')?.value as string;
    const loaded = await this.loader.inputIn(
      tx,
      {
        locationId,
        date: zonedParts(start, timeZone).date,
        partySize,
        channel: 'staff',
        now,
        ...(excludeReservationId && { excludeReservationId }),
        until: end ?? new Date(start.getTime() + MAX_BOOKING_MINUTES * 60_000),
      },
      resolved,
    );
    return { input: { ...loaded.input, partySize }, settings: loaded.settings };
  }

  private async recordOverride(
    tx: TenantTransactionClient,
    userId: string,
    row: ReservationRow,
    overridden: RuleBreach[],
  ): Promise<void> {
    if (overridden.length === 0) return;
    await this.audit.record(tx, {
      action: 'reservations.reservation.rules_overridden',
      actor: auditActor.user(userId),
      entityId: row.id,
      after: snapshot('reservation', { ...reservationFields(row), overriddenRules: overridden }),
    });
  }

  /** The booking, if the caller reads bookings at its location (else 404). Writes pass their `tx`. */
  async readable(id: string, tx?: TenantTransactionClient) {
    const found = await (tx ?? this.db).reservation.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!found || !(await this.access.can(READ, { locationId: found.locationId }))) {
      throw reservationErrors.reservationNotFound();
    }
    return found;
  }

  /** …and manages them there (else 403). */
  async manageable(id: string, tx?: TenantTransactionClient) {
    const found = await this.readable(id, tx);
    await this.access.assert(MANAGE, { locationId: found.locationId });
    return found;
  }
}

/**
 * A placeholder until the tables are claimed (unique, never shown: replaced in the same
 * transaction). `~` + 31 hex digits fits the 32-character number CHECK.
 */
export const temporaryNumber = () => `~${randomUUID().replace(/-/g, '').slice(0, 31)}`;

/** The booking's real number from its series, after the table rows are in. */
export async function assignNumber(
  tx: TenantTransactionClient,
  numbering: NumberingService,
  id: string,
): Promise<void> {
  const { number } = await numbering.next('reservations.booking', tx);
  await tx.reservation.update({ where: { id }, data: { number } });
}

/** The breaches `force` overrides; without it the first one refuses (pacing before hours). */
function breachesAllowed(breaches: RuleBreach[], force: boolean | undefined): RuleBreach[] {
  if (breaches.length === 0) return [];
  if (!force) {
    throw breaches.includes('pacing')
      ? reservationErrors.pacingExceeded()
      : reservationErrors.outsideServiceHours();
  }
  return breaches;
}

export function problemError(
  problem: Exclude<ReturnType<typeof evaluateBooking>, { ok: true }>['problem'],
  nextStartsAt?: string,
) {
  switch (problem) {
    case 'table_not_found':
      return reservationErrors.tableNotFound();
    case 'table_walk_in_only':
      return reservationErrors.tableWalkInOnly();
    case 'party_size_out_of_range':
      return reservationErrors.partySizeOutOfRange();
    case 'table_occupied':
      return reservationErrors.tableOccupied();
    case 'table_unavailable':
      return reservationErrors.tableUnavailable(nextStartsAt ? { nextStartsAt } : undefined);
  }
}

/** The guest as typed, with the phone in E.164 for the location's country (422 when invalid). */
export function guestDetails(
  guest: ReservationGuestInput,
  settings: ReadonlyMap<string, { value: unknown }>,
): Partial<GuestDetails> {
  let phone: string | undefined;
  if (guest.phone !== undefined) {
    const country = asCountryCode(settings.get('country')?.value as string);
    const normalised = normalisePhone(guest.phone, country);
    if (!normalised.ok) throw reservationErrors.phoneInvalid('guest.phone');
    phone = normalised.e164;
  }
  return {
    ...(guest.name !== undefined && { name: guest.name }),
    ...(guest.email !== undefined && { email: guest.email }),
    ...(phone !== undefined && { phone }),
    ...(guest.locale !== undefined && { locale: guest.locale }),
  };
}

/** The table rows; `period` and `blocking` match the reservation (its trigger checks). */
export async function insertTables(
  tx: TenantTransactionClient,
  tenantId: string,
  reservationId: string,
  locationId: string,
  tableIds: readonly string[],
  start: Date,
  end: Date,
): Promise<void> {
  for (const tableId of tableIds) {
    await exclusive(
      () => tx.$executeRaw`
        INSERT INTO reservation_tables (tenant_id, reservation_id, location_id, table_id, period, blocking)
        SELECT ${tenantId}::uuid, ${reservationId}::uuid, ${locationId}::uuid, ${tableId}::uuid,
               tstzrange(${start}, ${end}, '[)'), status IN ('pending', 'booked', 'arrived', 'seated')
          FROM reservations WHERE id = ${reservationId}::uuid`,
    );
  }
}

/** Runs `fn`; the exclusion constraint's violation (another booking won the race) → 409. */
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isExclusionViolation(error)) throw reservationErrors.tableUnavailable();
    throw error;
  }
}

function isExclusionViolation(error: unknown): boolean {
  const text = `${String(error)} ${JSON.stringify((error as { meta?: unknown } | null)?.meta ?? null)}`;
  return text.includes('23P01') || text.includes('reservation_tables_no_overlap');
}

export async function read(tx: TenantTransactionClient, id: string): Promise<ReservationRow> {
  const row = await tx.reservation.findUnique({ where: { id }, select: RESERVATION_SELECT });
  if (!row) throw reservationErrors.reservationNotFound();
  return row;
}

function reservationFields(row: ReservationRow) {
  return {
    id: row.id,
    number: row.number,
    locationId: row.locationId,
    partySize: row.partySize,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    source: row.source,
    tableIds: row.tables.map((t) => t.tableId),
  };
}

export const reservationSnapshot = (row: ReservationRow) =>
  snapshot('reservation', reservationFields(row));

export const payloadOf = (row: ReservationRow) => ({
  reservationId: row.id,
  locationId: row.locationId,
  status: row.status,
  startsAt: row.startsAt.toISOString(),
});

export function toResponse(row: ReservationRow): Reservation {
  return {
    id: row.id,
    number: row.number,
    locationId: row.locationId,
    status: row.status,
    source: row.source,
    partySize: row.partySize,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    tableIds: row.tables.map((t) => t.tableId),
    guest: row.guest,
    guestNote: row.guestNote,
    staffNote: row.staffNote,
    createdAt: row.createdAt.toISOString(),
    lastChangeId: row.changes[0]!.id,
  };
}
