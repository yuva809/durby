import { Inject, Injectable } from '@nestjs/common';
import {
  type ReservationsFloorQuery,
  type ReservationsFloorResponse,
  type SettingKey,
  type SettingValue,
  zonedDayBounds,
  zonedParts,
} from '@durby/shared';
import { Clock } from '../../platform/auth';
import { type ResolvedSettings, SettingsService } from '../../platform/config/settings';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, type TenantPrismaClient } from '../../platform/tenancy';
import { PosFloorReader } from '../pos';
import { serviceWindows } from './availability/engine';
import { BLOCKING_STATUSES } from './bookings/bookings.service';
import { deriveFloor } from './floor/derive';
import { readableLocation } from './setup/table-rules.service';

/**
 * The host floor (docs/modules/reservations.md → Derived floor state): a location's tables at a
 * moment, with the bookings and (today) the open pos orders on them. pos is read through its read
 * port only (ADR 0019 §7): nothing about the orders beyond when they opened and their covers, so
 * Host needs no pos order key. Everything is read in one read-only transaction (ADR 0021 §5);
 * deriveFloor does the rest.
 */
@Injectable()
export class FloorService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly pos: PosFloorReader,
    private readonly clock: Clock,
  ) {}

  floor(query: ReservationsFloorQuery): Promise<ReservationsFloorResponse> {
    const { locationId } = query;
    const now = this.clock.now();
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        // A location the caller can't read bookings at doesn't exist for them (404, like unknown ids).
        await readableLocation(tx, this.access, locationId);
        const resolved = await this.settings.all({ locationId }, tx);
        const timeZone = setting(resolved, 'timezone');
        const hours = {
          openingHours: setting(resolved, 'openingHours'),
          closedDates: setting(resolved, 'closedDates'),
          serviceHours: setting(resolved, 'reservations.serviceHours'),
        };

        // The moment: now, `at`, or a date (today = now; another day = its first service window).
        const today = zonedParts(now, timeZone).date;
        let at = now;
        if (query.at) at = new Date(query.at);
        const date = query.at ? zonedParts(at, timeZone).date : (query.date ?? today);
        const windows = serviceWindows({ date, timeZone, settings: hours });
        if (!query.at && date !== today) {
          at = new Date(windows[0]?.start ?? zonedDayBounds(date, timeZone).start.getTime());
        }
        const live = date === today;

        const day = zonedDayBounds(date, timeZone);
        const [tables, rules, bookings, openOrders] = [
          await this.pos.tablesAt(locationId, tx),
          await tx.reservationTableRule.findMany({
            where: { locationId },
            select: { tableId: true, bookingMode: true },
          }),
          // What can be current or next at `at` that day; live, seated parties until finished (overrun).
          await tx.reservation.findMany({
            where: {
              locationId,
              status: { in: [...BLOCKING_STATUSES] },
              startsAt: { lt: day.end },
              OR: [{ endsAt: { gt: at } }, ...(live ? [{ status: 'seated' as const }] : [])],
            },
            select: {
              id: true,
              status: true,
              partySize: true,
              startsAt: true,
              endsAt: true,
              seatedAt: true,
              guest: { select: { name: true } },
              tables: { select: { tableId: true } },
            },
          }),
          live ? await this.pos.openOrders(locationId, tx) : [],
        ];

        const modeOf = new Map(rules.map((r) => [r.tableId, r.bookingMode]));
        const states = deriveFloor({
          at,
          now,
          live,
          timeZone,
          slotIntervalMinutes: setting(resolved, 'reservations.slotIntervalMinutes'),
          horizonMinutes: setting(resolved, 'reservations.floorHorizonMinutes'),
          turnTimes: setting(resolved, 'reservations.turnTimes'),
          tables: tables.map((t) => ({
            id: t.id,
            seats: t.seats,
            bookingMode: modeOf.get(t.id) ?? 'all',
          })),
          bookings: bookings.map((b) => ({
            id: b.id,
            // The where clause keeps blocking statuses only.
            status: b.status as (typeof BLOCKING_STATUSES)[number],
            partySize: b.partySize,
            start: b.startsAt,
            end: b.endsAt,
            seatedAt: b.seatedAt,
            tableIds: b.tables.map((t) => t.tableId),
            guestName: b.guest.name,
          })),
          openOrders,
        });

        return {
          data: tables.map((table, i) => {
            const { current, next, state, overrun, walkInOnly } = states[i]!;
            const occupied = state === 'occupied';
            return {
              id: table.id,
              locationId: table.locationId,
              name: table.name,
              seats: table.seats,
              areaId: table.areaId,
              area: table.area,
              shape: table.shape,
              color: table.color,
              sortOrder: table.sortOrder,
              state,
              overrun,
              walkInOnly,
              current: current && {
                ...current,
                since: current.since.toISOString(),
                until: current.until?.toISOString() ?? null,
              },
              next: next && { ...next, startsAt: next.startsAt.toISOString() },
              occupied,
              occupiedSince: occupied ? current!.since.toISOString() : null,
              covers: occupied ? current!.partySize : null,
            };
          }),
          at: at.toISOString(),
          date,
          live,
          timeZone,
          serviceWindows: windows.map((w) => ({
            start: new Date(w.start).toISOString(),
            end: new Date(w.end).toISOString(),
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

/** A resolved value; every registered key resolves (code default at the latest). */
function setting<K extends SettingKey>(resolved: ResolvedSettings, key: K): SettingValue<K> {
  return resolved.get(key)?.value as SettingValue<K>;
}
