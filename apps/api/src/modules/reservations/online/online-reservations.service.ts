import { randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type ManageBooking,
  type PublicBooking,
  type PublicBookingRequest,
  type PublicRequestRequest,
  zonedParts,
  RESERVATION_STATUSES,
} from '@durby/shared';
import { auditActor, AuditService } from '../../../platform/audit';
import { AuthRateLimits, Clock, generateToken, hashToken } from '../../../platform/auth';
import { type ResolvedSettings, SettingsService } from '../../../platform/config/settings';
import { NumberingService } from '../../../platform/numbering';
import { OutboxService } from '../../../platform/outbox';
import { RedisService } from '../../../platform/redis';
import { HostPartners } from '../../../platform/theme';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { evaluateBooking } from '../availability/engine';
import { AvailabilityLoader } from '../availability/loader';
import {
  assignNumber,
  BookingsService,
  guestDetails,
  insertTables,
  payloadOf,
  problemError,
  read,
  reservationSnapshot,
  temporaryNumber,
} from '../bookings/bookings.service';
import { shortLockWaits } from '../bookings/busy';
import { resolveGuest } from '../bookings/guests';
import { reservationErrors } from '../reservations-errors';
import { type Hold, HoldStore } from './hold-store';
import { type Page, PublicBookingService } from './public-booking.service';

/** Guests have no user id; RLS and the status history only need the tenant (as the QR menu, ADR 0026). */
const ANONYMOUS = '00000000-0000-0000-0000-000000000000';
/** A booking's answer is kept this long, so the same hold sent again gets the same answer (double click, retry). */
const REPLAY_MS = 15 * 60_000;
/** While one request books a hold, the same hold again waits this long for its answer. */
const CLAIM_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CANCELLABLE = ['booked', 'pending', 'requested'] as const;

const replayKey = (tenantId: string, holdId: string) => `resv:booked:${tenantId}:${holdId}`;

/** `<organizationId>.<secret>` → the organization and the stored hash, else null. */
export function parseManageToken(token: string): { organizationId: string; hash: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const organizationId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID.test(organizationId) || !SECRET.test(secret)) return null;
  return { organizationId: organizationId.toLowerCase(), hash: hashToken(secret) };
}

/**
 * A guest books from the public page and manages the booking with its link (docs/modules/reservations.md → R2.3a).
 * The hold (R2.2) names the tables, time and party; the exclusion constraint still decides. The manage token is
 * `<organizationId>.<secret>`; only the secret's hash is stored, the token is shown once and never logged.
 */
@Injectable()
export class OnlineReservationsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly pages: PublicBookingService,
    private readonly holds: HoldStore,
    private readonly bookings: BookingsService,
    private readonly settings: SettingsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
    private readonly limits: AuthRateLimits,
    private readonly hosts: HostPartners,
    private readonly loader: AvailabilityLoader,
    private readonly clock: Clock,
  ) {}

  book(
    slug: string,
    body: PublicBookingRequest,
    host: string | undefined,
    ip: string,
  ): Promise<PublicBooking> {
    return this.pages.within(slug, host, ip, async (page) => {
      if (body.website) return this.decoy(body);
      const key = replayKey(page.tenantId, body.holdId);
      // One request books a hold; the same hold again (double click, retry) gets that request's answer.
      const claimed = await this.redisCall(() =>
        this.redis.set(key, 'pending', 'PX', CLAIM_MS, 'NX'),
      );
      if (claimed !== 'OK') return this.replay(key);
      try {
        const hold = await this.holds.get(page.tenantId, page.slug, body.holdId);
        if (!hold || hold.locationId !== page.locationId) throw reservationErrors.holdNotFound();
        const answer = await this.create(page, hold, body);
        await this.redisCall(() => this.redis.set(key, JSON.stringify(answer), 'PX', REPLAY_MS));
        await this.holds
          .release(page.tenantId, page.slug, page.locationId, hold.holdId)
          .catch(() => undefined);
        return answer;
      } catch (error) {
        await this.redis.del(key).catch(() => undefined);
        throw error;
      }
    });
  }

  view(token: string, host: string | undefined, ip: string): Promise<ManageBooking> {
    return this.withToken(token, host, ip, async (reservationId) =>
      this.db.$transaction((tx) => this.manageView(tx, reservationId)),
    );
  }

  /** Cancels until the cut-off; already cancelled answers the same again. */
  cancel(token: string, host: string | undefined, ip: string): Promise<ManageBooking> {
    return this.withToken(token, host, ip, (reservationId) =>
      this.db.$transaction(async (tx) => {
        await shortLockWaits(tx);
        await tx.$executeRaw`SELECT 1 FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
        const before = await read(tx, reservationId);
        if (before.status === 'cancelled') return this.manageView(tx, reservationId);
        const until = await this.cancelUntil(tx, before.locationId, before.startsAt);
        const now = this.clock.now();
        if (
          !(CANCELLABLE as readonly string[]).includes(before.status) ||
          now.getTime() > until.getTime()
        ) {
          throw reservationErrors.selfCancelClosed();
        }
        const { tenantId } = this.tenantContext.require();
        await tx.reservation.update({
          where: { id: reservationId },
          data: { status: 'cancelled', cancelledAt: now },
        });
        await tx.reservationStatusChange.create({
          data: {
            tenantId,
            reservationId,
            fromStatus: before.status,
            toStatus: 'cancelled',
            actorUserId: null,
            actorKind: 'guest',
          },
        });
        const after = await read(tx, reservationId);
        await this.audit.record(tx, {
          action: 'reservations.reservation.status_changed',
          actor: auditActor.system('guest.online'),
          entityId: reservationId,
          before: reservationSnapshot(before),
          after: reservationSnapshot(after),
        });
        await this.outbox.add(tx, {
          type: 'reservations.reservation.status_changed',
          payload: payloadOf(after),
        });
        return this.manageView(tx, reservationId);
      }),
    );
  }

  private async create(page: Page, hold: Hold, body: PublicBookingRequest): Promise<PublicBooking> {
    const now = this.clock.now();
    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      const { input, settings } = await this.bookings.load(
        tx,
        page.locationId,
        hold.start,
        hold.partySize,
        now,
        undefined,
        hold.end,
      );
      // The tables are still free and the rules still allow it (no staff override online).
      const verdict = evaluateBooking(
        { ...input, channel: 'online' },
        { start: hold.start, end: hold.end, tableIds: hold.tableIds },
      );
      if (!verdict.ok) throw problemError(verdict.problem);
      if (verdict.breaches.length > 0) throw reservationErrors.tableUnavailable();
      const status =
        settings.get('reservations.autoConfirm')?.value === false ? 'pending' : 'booked';
      const answer = await this.insert(tx, page, settings, body, {
        start: hold.start,
        end: hold.end,
        partySize: hold.partySize,
        status,
        tableIds: verdict.tableIds,
      });
      if (status === 'pending') {
        // Unconfirmed, it expires and frees its tables (R2.3b, delayed event R2.0).
        const minutes = settings.get('reservations.online.pendingExpiryMinutes')?.value as number;
        await this.outbox.add(
          tx,
          {
            type: 'reservations.pending.expiry_due',
            payload: { reservationId: answer.id, locationId: page.locationId },
          },
          { availableAt: new Date(now.getTime() + minutes * 60_000) },
        );
      }
      return answer.booking;
    });
  }

  /**
   * A larger party's request (R2.3b): no table, nothing held, nothing blocked; the restaurant accepts or declines on
   * /host. For a start the online engine marks `request`, or any start of the day's grid when the party is larger than
   * every table or combination bookable online ("Large group? Send a request").
   */
  request(
    slug: string,
    body: PublicRequestRequest,
    host: string | undefined,
    ip: string,
  ): Promise<PublicBooking> {
    return this.pages.within(slug, host, ip, async (page) => {
      if (body.website) return { ...this.decoy(body), status: 'requested' as const };
      const start = new Date(body.startsAt);
      const key = `resv:requested:${page.tenantId}:${hashToken(
        `${page.slug}|${body.guest.email.toLowerCase()}|${start.toISOString()}|${body.partySize}`,
      )}`;
      const claimed = await this.redisCall(() =>
        this.redis.set(key, 'pending', 'PX', CLAIM_MS, 'NX'),
      );
      if (claimed !== 'OK') return this.replay(key);
      try {
        const answer = await this.createRequest(page, start, body);
        await this.redisCall(() => this.redis.set(key, JSON.stringify(answer), 'PX', REPLAY_MS));
        return answer;
      } catch (error) {
        await this.redis.del(key).catch(() => undefined);
        throw error;
      }
    });
  }

  private async createRequest(
    page: Page,
    start: Date,
    body: PublicRequestRequest,
  ): Promise<PublicBooking> {
    const now = this.clock.now();
    const resolved = await this.settings.all({ locationId: page.locationId });
    const result = await this.loader.load({
      locationId: page.locationId,
      date: zonedParts(start, resolved.get('timezone')?.value as string).date,
      partySize: body.partySize,
      channel: 'online',
      now,
      holds: await this.holds.live(page.tenantId, page.locationId),
    });
    const slot = result.slots.find((s) => Date.parse(s.start) === start.getTime());
    const tooLarge =
      result.slots.length > 0 &&
      result.slots.every((s) => s.status === 'full' && s.reason === 'no_table');
    if (!slot || !(slot.status === 'request' || tooLarge)) {
      throw reservationErrors.tableUnavailable();
    }
    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      const settings = await this.settings.all({ locationId: page.locationId }, tx);
      const answer = await this.insert(tx, page, settings, body, {
        start,
        end: new Date(slot.end),
        partySize: body.partySize,
        status: 'requested',
        tableIds: [],
      });
      return answer.booking;
    });
  }

  /** The booking row, its tables, number, history, consent, audit and event; the guest's answer. */
  private async insert(
    tx: TenantTransactionClient,
    page: Page,
    settings: ResolvedSettings,
    body: PublicBookingRequest | PublicRequestRequest,
    booking: {
      start: Date;
      end: Date;
      partySize: number;
      status: 'booked' | 'pending' | 'requested';
      tableIds: readonly string[];
    },
  ): Promise<{ id: string; booking: PublicBooking }> {
    const { tenantId } = this.tenantContext.require();
    const { token, hash } = issueManageToken(tenantId);
    const guest = guestDetails(body.guest, settings);
    const guestId = await resolveGuest(tx, tenantId, {
      ...guest,
      locale: guest.locale ?? (settings.get('locale')?.value as string),
    });
    const { id } = await tx.reservation.create({
      data: {
        tenantId,
        locationId: page.locationId,
        number: temporaryNumber(),
        guestId,
        partySize: booking.partySize,
        startsAt: booking.start,
        endsAt: booking.end,
        status: booking.status,
        source: 'online',
        guestNote: body.guestNote ?? null,
        manageTokenHash: hash,
        createdByUserId: null,
      },
      select: { id: true },
    });
    if (booking.tableIds.length > 0) {
      await insertTables(
        tx,
        tenantId,
        id,
        page.locationId,
        booking.tableIds,
        booking.start,
        booking.end,
      );
    }
    await assignNumber(tx, this.numbering, id);
    await tx.reservationStatusChange.create({
      data: {
        tenantId,
        reservationId: id,
        fromStatus: null,
        toStatus: booking.status,
        actorUserId: null,
        actorKind: 'guest',
      },
    });
    if (body.marketingOptIn) {
      await tx.guestMarketingConsent.create({
        data: { tenantId, guestId, reservationId: id, granted: true, source: 'online_booking' },
      });
    }
    const row = await read(tx, id);
    await this.audit.record(tx, {
      action: 'reservations.reservation.created',
      actor: auditActor.system('guest.online'),
      entityId: id,
      after: reservationSnapshot(row),
    });
    await this.outbox.add(tx, {
      type: 'reservations.reservation.created',
      payload: payloadOf(row),
    });
    const names = await this.names(tx, page.locationId);
    return {
      id,
      booking: {
        number: row.number,
        status: booking.status,
        ...names,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        partySize: row.partySize,
        guestName: body.guest.name,
        manageToken: token,
      },
    };
  }

  /** The answer of the request that booked this hold, once it's there; a hold nobody booked is gone. */
  private async replay(key: string): Promise<PublicBooking> {
    for (let i = 0; i < 25; i += 1) {
      const raw = await this.redisCall(() => this.redis.get(key));
      if (raw && raw !== 'pending') return JSON.parse(raw) as PublicBooking;
      if (!raw) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw reservationErrors.holdNotFound();
  }

  /** A believable answer for a bot (honeypot): nothing is written. */
  private decoy(body: PublicBookingRequest | PublicRequestRequest): PublicBooking {
    const start = new Date(Date.now() + 86_400_000);
    return {
      number: `RES-${start.getUTCFullYear()}-${String(randomInt(1, 999_999)).padStart(6, '0')}`,
      status: 'booked',
      restaurant: '',
      location: '',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 90 * 60_000).toISOString(),
      partySize: 2,
      guestName: body.guest.name,
      manageToken: `${randomUUID()}.${generateToken()}`,
    };
  }

  private async withToken<T>(
    token: string,
    host: string | undefined,
    ip: string,
    fn: (reservationId: string) => Promise<T>,
  ): Promise<T> {
    await this.limits.enforce([this.limits.rules.publicBookingIp, ip]);
    const parsed = parseManageToken(token);
    if (!parsed || !(await this.hosts.serves(host, parsed.organizationId))) {
      throw reservationErrors.bookingNotFound();
    }
    return this.tenantContext.run(
      { tenantId: parsed.organizationId, userId: ANONYMOUS },
      async () => {
        // The link shown after booking (R2.3a) or one sent by email (R2.4).
        const found =
          (await this.db.reservation.findUnique({
            where: { manageTokenHash: parsed.hash },
            select: { id: true },
          })) ??
          (await this.db.reservationManageToken
            .findUnique({ where: { tokenHash: parsed.hash }, select: { reservationId: true } })
            .then((row) => (row ? { id: row.reservationId } : null)));
        if (!found) throw reservationErrors.bookingNotFound();
        return fn(found.id);
      },
    );
  }

  private async manageView(tx: TenantTransactionClient, id: string): Promise<ManageBooking> {
    const row = await read(tx, id);
    const [names, until, page, resolved] = await Promise.all([
      this.names(tx, row.locationId),
      this.cancelUntil(tx, row.locationId, row.startsAt),
      tx.reservationBookingPage.findFirst({
        where: { locationId: row.locationId, enabled: true },
        select: { slug: true },
      }),
      this.settings.all({ locationId: row.locationId }, tx),
    ]);
    const status = (RESERVATION_STATUSES as readonly string[]).includes(row.status)
      ? row.status
      : 'cancelled';
    return {
      number: row.number,
      status,
      ...names,
      timeZone: resolved.get('timezone')?.value as string,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      partySize: row.partySize,
      guestName: row.guest.name,
      canCancel:
        (CANCELLABLE as readonly string[]).includes(row.status) &&
        this.clock.now().getTime() <= until.getTime(),
      cancelUntil: until.toISOString(),
      pageSlug: page?.slug ?? null,
    };
  }

  private async cancelUntil(tx: TenantTransactionClient, locationId: string, startsAt: Date) {
    const resolved = await this.settings.all({ locationId }, tx);
    const cutoff = resolved.get('reservations.selfCancelCutoffMinutes')?.value as number;
    return new Date(startsAt.getTime() - cutoff * 60_000);
  }

  private async names(tx: TenantTransactionClient, locationId: string) {
    const { tenantId } = this.tenantContext.require();
    const [organization, location] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
      tx.location.findUniqueOrThrow({ where: { id: locationId }, select: { name: true } }),
    ]);
    return { restaurant: organization.name, location: location.name };
  }

  private async redisCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw reservationErrors.holdsUnavailable();
    }
  }
}

/** `<organizationId>.<secret>`; only the secret's hash is stored. */
function issueManageToken(organizationId: string): { token: string; hash: string } {
  const secret = generateToken();
  return { token: `${organizationId}.${secret}`, hash: hashToken(secret) };
}
