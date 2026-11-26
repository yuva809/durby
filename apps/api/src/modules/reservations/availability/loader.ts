import { Inject, Injectable } from '@nestjs/common';
import {
  type LocalDate,
  type SettingKey,
  type SettingValue,
  turnTimeFor,
  zonedDayBounds,
} from '@durby/shared';
import { ApiError } from '../../../platform/http';
import { type ResolvedSettings, SettingsService } from '../../../platform/config/settings';
import {
  TENANT_PRISMA,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { PosFloorReader } from '../../pos';
import { reservationErrors } from '../reservations-errors';
import {
  availability,
  type AvailabilityInput,
  type AvailabilityResult,
  type Channel,
  type EngineHold,
  type EngineSettings,
} from './engine';

export interface AvailabilityRequest {
  locationId: string;
  date: LocalDate;
  partySize: number;
  channel: Channel;
  now: Date;
  /** Moving a booking: leave it out, so it doesn't block itself. */
  excludeReservationId?: string;
  /** Also load bookings up to here (a write's own end, when it runs past the day). */
  until?: Date;
  /** Other guests' live holds (online channel, R2.2); read from Redis by the caller. */
  holds?: readonly EngineHold[];
}

/** The engine's input and the location's settings (bookings read country, locale, turn times). */
export interface LoadedInput {
  input: AvailabilityInput;
  settings: ResolvedSettings;
}

const BLOCKING = ['pending', 'booked', 'arrived', 'seated'] as const;

/**
 * Feeds the availability engine (docs/modules/reservations.md → Availability engine) from one fixed
 * batch of queries per location and day, in one transaction: settings, tables, table rules,
 * combinations, the bookings that can touch the day and the open pos orders. Never a query per slot or per booking. Checks no
 * permission keys: callers check theirs at the location first.
 */
@Injectable()
export class AvailabilityLoader {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly settings: SettingsService,
    private readonly pos: PosFloorReader,
  ) {}

  /**
   * All reads run in one read-only REPEATABLE READ transaction: one pooled connection per call and
   * one snapshot, so settings, tables and bookings agree with each other.
   */
  load(request: AvailabilityRequest): Promise<AvailabilityResult> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return availability((await this.inputIn(tx, request)).input);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  /**
   * The engine's input for `request`, read in the caller's transaction: a booking write checks
   * against what its own transaction sees (docs/modules/reservations.md → R1.6 write-time checks).
   * A caller that already resolved the location's settings in `tx` passes them (resolved once).
   */
  async inputIn(
    tx: TenantTransactionClient,
    request: AvailabilityRequest,
    resolvedSettings?: ResolvedSettings,
  ): Promise<LoadedInput> {
    const { locationId, date, partySize } = request;
    const resolved = resolvedSettings ?? (await this.settingsAt(locationId, tx));
    const timeZone = setting(resolved, 'timezone');
    const settings: EngineSettings = {
      openingHours: setting(resolved, 'openingHours'),
      closedDates: setting(resolved, 'closedDates'),
      serviceHours: setting(resolved, 'reservations.serviceHours'),
      slotIntervalMinutes: setting(resolved, 'reservations.slotIntervalMinutes'),
      turnTimes: setting(resolved, 'reservations.turnTimes'),
      maxCoversPerSlot: setting(resolved, 'reservations.maxCoversPerSlot'),
      lastBookingOffsetMinutes: setting(resolved, 'reservations.lastBookingOffsetMinutes'),
      instantMaxParty: setting(resolved, 'reservations.online.instantMaxParty'),
      minLeadMinutes: setting(resolved, 'reservations.minLeadMinutes'),
      maxAdvanceDays: setting(resolved, 'reservations.maxAdvanceDays'),
    };

    // Bookings that can overlap a slot: slots start within the local day (a window past midnight
    // belongs to the day it starts) and last one turn time. Seated parties count until finished
    // (overrun), wherever their planned end lies.
    const day = zonedDayBounds(date, timeZone);
    const dayEnd = day.end.getTime() + turnTimeFor(partySize, settings.turnTimes) * 60_000;
    const until = new Date(Math.max(dayEnd, request.until?.getTime() ?? 0));
    const [tables, rules, combinations, bookings, openOrders] = [
      await this.pos.tablesAt(locationId, tx),
      await tx.reservationTableRule.findMany({
        where: { locationId },
        select: { tableId: true, bookingMode: true, minParty: true, maxParty: true },
      }),
      await tx.reservationCombination.findMany({
        where: { locationId, archivedAt: null },
        select: {
          id: true,
          name: true,
          minParty: true,
          maxParty: true,
          onlineBookable: true,
          tables: { select: { tableId: true }, orderBy: { tableId: 'asc' } },
        },
      }),
      await tx.reservation.findMany({
        where: {
          locationId,
          ...(request.excludeReservationId && { id: { not: request.excludeReservationId } }),
          status: { in: [...BLOCKING] },
          startsAt: { lt: until },
          OR: [{ endsAt: { gt: day.start } }, { status: 'seated' }],
        },
        select: {
          id: true,
          status: true,
          partySize: true,
          startsAt: true,
          endsAt: true,
          tables: { select: { tableId: true } },
        },
      }),
      await this.pos.openOrders(locationId, tx),
    ];

    const ruleOf = new Map(rules.map((r) => [r.tableId, r]));
    const input: AvailabilityInput = {
      ...(request.holds && { holds: request.holds }),
      date,
      timeZone,
      now: request.now,
      channel: request.channel,
      partySize,
      settings,
      tables: tables.map((t) => {
        const rule = ruleOf.get(t.id);
        return {
          id: t.id,
          name: t.name,
          seats: t.seats,
          sortOrder: t.sortOrder,
          bookingMode: rule?.bookingMode ?? 'all',
          minParty: rule?.minParty ?? 1,
          maxParty: rule?.maxParty ?? null,
        };
      }),
      combinations: combinations.map((c) => ({
        id: c.id,
        name: c.name,
        minParty: c.minParty,
        maxParty: c.maxParty,
        onlineBookable: c.onlineBookable,
        tableIds: c.tables.map((t) => t.tableId),
      })),
      bookings: bookings.map((b) => ({
        id: b.id,
        // The where clause keeps blocking statuses only.
        status: b.status as (typeof BLOCKING)[number],
        partySize: b.partySize,
        start: b.startsAt,
        end: b.endsAt,
        tableIds: b.tables.map((t) => t.tableId),
      })),
      openOrders: openOrders.map((o) => ({
        tableId: o.tableId,
        openedAt: o.openedAt,
        covers: o.covers,
      })),
    };
    return { input, settings: resolved };
  }

  /** The location's settings; an unknown or foreign location is the module's 404. */
  private async settingsAt(
    locationId: string,
    tx: TenantTransactionClient,
  ): Promise<ResolvedSettings> {
    try {
      return await this.settings.all({ locationId }, tx);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'settings.location_not_found') {
        throw reservationErrors.locationNotFound();
      }
      throw error;
    }
  }
}

/** A resolved value; every registered key resolves (code default at the latest). */
function setting<K extends SettingKey>(resolved: ResolvedSettings, key: K): SettingValue<K> {
  return resolved.get(key)?.value as SettingValue<K>;
}
