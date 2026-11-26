import { Inject, Injectable, Logger } from '@nestjs/common';
import { LOCALES } from '@durby/i18n';
import {
  asCountryCode,
  type AuditAction,
  type CreateWaitlistEntryRequest,
  normalisePhone,
  type NotifyWaitlistEntryRequest,
  OPEN_WAITLIST_STATUSES,
  type PermissionKey,
  type SeatWaitlistEntryRequest,
  type SeatWaitlistEntryResponse,
  type UpdateWaitlistEntryRequest,
  WAITLIST_MAX_EMAILS,
  WAITLIST_NOTICE_GAP_MS,
  type WaitlistEntry,
  type WaitlistNoticeResult,
  type WaitlistResponse,
  zonedDayBounds,
  zonedParts,
} from '@durby/shared';
import { auditActor, AuditService } from '../../../platform/audit';
import { Clock } from '../../../platform/auth';
import { type ResolvedSettings, SettingsService } from '../../../platform/config/settings';
import { IdempotencyService } from '../../../platform/idempotency';
import { LabelService } from '../../../platform/labels';
import { MailDispatcher } from '../../../platform/mail';
import { OutboxService } from '../../../platform/outbox';
import { AccessService } from '../../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { shortLockWaits } from '../bookings/busy';
import { BookingStatusService } from '../bookings/status.service';
import { reservationErrors } from '../reservations-errors';
import { readableLocation } from '../setup/table-rules.service';
import { GuestNotifier } from './guest-notifier';
import { ENTRY_SELECT, type EntryRow, entrySnapshot, toEntry } from './waitlist-row';

const CREATE = 'reservations.waitlist.create';
const EDIT = 'reservations.waitlist.edit';
const DELETE = 'reservations.waitlist.delete';
const SEAT = 'reservations.bookings.create';

type Action = Extract<AuditAction, `reservations.waitlist_entry.${string}`>;

const isOpen = (row: EntryRow) =>
  (OPEN_WAITLIST_STATUSES as readonly string[]).includes(row.status);

/** The waitlist of the host screen (docs/modules/reservations.md → Waitlist, ADR 0084). */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly bookings: BookingStatusService,
    private readonly notifier: GuestNotifier,
    private readonly labels: LabelService,
    private readonly dispatcher: MailDispatcher,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
  ) {}

  async list(locationId: string): Promise<WaitlistResponse> {
    const now = this.clock.now();
    const { restaurant, ...list } = await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await readableLocation(tx, this.access, locationId);
        const settings = await this.settings.all({ locationId }, tx);
        const { start, end } = today(settings, now);
        const open = await tx.waitlistEntry.findMany({
          where: { locationId, status: { in: [...OPEN_WAITLIST_STATUSES] } },
          select: ENTRY_SELECT,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const ended = await tx.waitlistEntry.findMany({
          where: { locationId, endedAt: { gte: start, lt: end } },
          select: ENTRY_SELECT,
          orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
        });
        return {
          holdMinutes: holdMinutes(settings),
          restaurant: await this.restaurant(tx, locationId),
          open: open.map(toEntry),
          ended: ended.map(toEntry),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    const readyText = {} as WaitlistResponse['readyText'];
    for (const locale of LOCALES) {
      const t = await this.labels.translator(locale);
      readyText[locale] = t('reservations.waitlist.readyText', {
        restaurant,
        minutes: list.holdMinutes,
      });
    }
    return { ...list, readyText };
  }

  create(body: CreateWaitlistEntryRequest): Promise<WaitlistEntry> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      await readableLocation(tx, this.access, body.locationId);
      await this.access.assert(CREATE, { locationId: body.locationId });
      const settings = await this.settings.all({ locationId: body.locationId }, tx);
      const row = await tx.waitlistEntry.create({
        data: {
          tenantId,
          locationId: body.locationId,
          name: body.name,
          phone: body.phone === undefined ? null : e164(body.phone, settings),
          email: body.email ?? null,
          locale: body.locale ?? (settings.get('locale')?.value as string),
          partySize: body.partySize,
          quotedMinutes: body.quotedMinutes ?? null,
          note: body.note ?? null,
          createdByUserId: userId,
          createdAt: this.clock.now(),
        },
        select: ENTRY_SELECT,
      });
      return this.finish(tx, 'reservations.waitlist_entry.added', null, row);
    });
  }

  update(id: string, body: UpdateWaitlistEntryRequest): Promise<WaitlistEntry> {
    return this.db.$transaction(async (tx) => {
      const before = await this.open(tx, id, EDIT);
      const settings = await this.settings.all({ locationId: before.locationId }, tx);
      const { phone, ...rest } = body;
      const data = {
        ...rest,
        ...(phone !== undefined && { phone: phone === null ? null : e164(phone, settings) }),
        // Another address may be written to at once; the limit per party stays.
        ...(body.email !== undefined && body.email !== before.email && { emailedAt: null }),
      };
      const row = await tx.waitlistEntry.update({ where: { id }, data, select: ENTRY_SELECT });
      return this.finish(tx, 'reservations.waitlist_entry.updated', before, row);
    });
  }

  /**
   * The entry is marked and the key completed first, so a repeated click never sends twice; the
   * email goes out after the commit and its result is stored when it is known.
   */
  async notify(id: string, body: NotifyWaitlistEntryRequest): Promise<WaitlistEntry> {
    const now = this.clock.now();
    const { entry, send } = await this.db.$transaction(async (tx) => {
      const before = await this.open(tx, id, EDIT);
      const email = body.channel === 'email';
      if (email) assertEmailAllowed(before, now);
      const row = await tx.waitlistEntry.update({
        where: { id },
        data: {
          status: 'notified',
          notifiedAt: now,
          noticeChannel: body.channel,
          noticeResult: email ? 'pending' : null,
          ...(email && { emailedAt: now, emailCount: before.emailCount + 1 }),
        },
        select: ENTRY_SELECT,
      });
      const settings = email
        ? await this.settings.all({ locationId: row.locationId }, tx)
        : undefined;
      const notice = settings && {
        to: row.email!,
        locale: row.locale,
        name: row.name!,
        restaurant: await this.restaurant(tx, row.locationId),
        holdMinutes: holdMinutes(settings),
      };
      return {
        entry: await this.finish(tx, 'reservations.waitlist_entry.notified', before, row),
        send: notice && (() => this.notifier.email(notice)),
      };
    });
    if (send) {
      await this.dispatcher.dispatch('reservations.waitlist_mail_failed', async () => {
        try {
          await send();
        } catch (error) {
          await this.record(entry, now, 'failed');
          throw error;
        }
        await this.record(entry, now, 'sent');
      });
    }
    return entry;
  }

  seat(id: string, body: SeatWaitlistEntryRequest): Promise<SeatWaitlistEntryResponse> {
    return this.db.$transaction(async (tx) => {
      const before = await this.open(tx, id, EDIT);
      await this.access.assert(SEAT, { locationId: before.locationId });
      const partySize = body.partySize ?? before.partySize;
      const reservation = await this.bookings.seatWalkIn(tx, {
        locationId: before.locationId,
        partySize,
        tableIds: body.tableIds,
        locale: before.locale,
        ...(before.name !== null && { name: before.name }),
        ...(before.phone !== null && { phone: before.phone }),
        ...(before.email !== null && { email: before.email }),
        ...(body.endsAt !== undefined && { endsAt: body.endsAt }),
      });
      const row = await tx.waitlistEntry.update({
        where: { id },
        data: {
          status: 'seated',
          partySize,
          endedAt: this.clock.now(),
          reservationId: reservation.id,
        },
        select: ENTRY_SELECT,
      });
      await this.changed(tx, 'reservations.waitlist_entry.seated', before, row);
      const response = { entry: toEntry(row), reservation };
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  leave(id: string): Promise<WaitlistEntry> {
    return this.end(id, EDIT, 'left', 'reservations.waitlist_entry.left');
  }

  remove(id: string): Promise<WaitlistEntry> {
    return this.end(id, DELETE, 'removed', 'reservations.waitlist_entry.removed');
  }

  /** Back at the old place, on the day the party left; the emails already sent still count. */
  return(id: string): Promise<WaitlistEntry> {
    return this.db.$transaction(async (tx) => {
      const before = await this.locked(tx, id, EDIT);
      if (before.status !== 'left') {
        throw reservationErrors.waitlistClosed({ status: before.status });
      }
      const settings = await this.settings.all({ locationId: before.locationId }, tx);
      const { start } = today(settings, this.clock.now());
      if (before.erasedAt !== null || before.endedAt! < start) {
        throw reservationErrors.waitlistReturnExpired();
      }
      const row = await tx.waitlistEntry.update({
        where: { id },
        data: {
          status: 'waiting',
          endedAt: null,
          notifiedAt: null,
          noticeChannel: null,
          noticeResult: null,
        },
        select: ENTRY_SELECT,
      });
      return this.finish(tx, 'reservations.waitlist_entry.returned', before, row);
    });
  }

  private end(
    id: string,
    key: PermissionKey,
    status: 'left' | 'removed',
    action: Action,
  ): Promise<WaitlistEntry> {
    return this.db.$transaction(async (tx) => {
      const before = await this.open(tx, id, key);
      const row = await tx.waitlistEntry.update({
        where: { id },
        data: { status, endedAt: this.clock.now() },
        select: ENTRY_SELECT,
      });
      return this.finish(tx, action, before, row);
    });
  }

  /** The entry, locked: one writer at a time. Not readable here = it doesn't exist (404). */
  private async locked(
    tx: TenantTransactionClient,
    id: string,
    key: PermissionKey,
  ): Promise<EntryRow> {
    await shortLockWaits(tx);
    await tx.$executeRaw`SELECT 1 FROM waitlist_entries WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.waitlistEntry.findUnique({ where: { id }, select: ENTRY_SELECT });
    if (
      !row ||
      !(await this.access.can('reservations.bookings.read', { locationId: row.locationId }))
    ) {
      throw reservationErrors.waitlistEntryNotFound();
    }
    await this.access.assert(key, { locationId: row.locationId });
    return row;
  }

  /** …and still on the list (else 409). */
  private async open(
    tx: TenantTransactionClient,
    id: string,
    key: PermissionKey,
  ): Promise<EntryRow> {
    const row = await this.locked(tx, id, key);
    if (!isOpen(row)) throw reservationErrors.waitlistClosed({ status: row.status });
    return row;
  }

  private async changed(
    tx: TenantTransactionClient,
    action: Action,
    before: EntryRow | null,
    after: EntryRow,
  ): Promise<void> {
    const { userId } = this.tenantContext.require();
    await this.audit.record(tx, {
      action,
      actor: auditActor.user(userId),
      entityId: after.id,
      ...(before && { before: entrySnapshot(before) }),
      after: entrySnapshot(after),
    });
    await this.hint(tx, after);
  }

  private async hint(
    tx: TenantTransactionClient,
    entry: { id: string; locationId: string },
  ): Promise<void> {
    await this.outbox.add(tx, {
      type: 'reservations.waitlist.changed',
      payload: { entryId: entry.id, locationId: entry.locationId },
    });
  }

  private async finish(
    tx: TenantTransactionClient,
    action: Action,
    before: EntryRow | null,
    after: EntryRow,
  ): Promise<WaitlistEntry> {
    await this.changed(tx, action, before, after);
    const response = toEntry(after);
    await this.idempotency.completeInTransaction(tx, response);
    return response;
  }

  /** The email's result, unless a later notice replaced it. Never fails the send: it is logged. */
  private async record(
    entry: WaitlistEntry,
    emailedAt: Date,
    result: WaitlistNoticeResult,
  ): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const { count } = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, notifiedAt: emailedAt, noticeChannel: 'email' },
          data: { noticeResult: result },
        });
        if (count > 0) await this.hint(tx, entry);
      });
    } catch {
      this.logger.error(
        { event: 'reservations.waitlist_result_not_stored', entryId: entry.id },
        'waitlist notice result not stored',
      );
    }
  }

  /** The organization's name, with the branch's when it has several in service. */
  private async restaurant(tx: TenantTransactionClient, locationId: string): Promise<string> {
    const { tenantId } = this.tenantContext.require();
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const branches = await tx.location.findMany({
      where: { archivedAt: null, isWarehouseSite: false },
      select: { id: true, name: true },
    });
    const branch = branches.find((b) => b.id === locationId);
    return branch && branches.length > 1
      ? `${organization.name} (${branch.name})`
      : organization.name;
  }
}

function assertEmailAllowed(entry: EntryRow, now: Date): void {
  if (entry.email === null) throw reservationErrors.waitlistNoEmail();
  if (entry.emailCount >= WAITLIST_MAX_EMAILS) throw reservationErrors.waitlistNoticeLimit();
  if (
    entry.emailedAt !== null &&
    entry.noticeResult !== 'failed' &&
    now.getTime() - entry.emailedAt.getTime() < WAITLIST_NOTICE_GAP_MS
  ) {
    throw reservationErrors.waitlistNoticeTooSoon();
  }
}

function e164(phone: string, settings: ResolvedSettings): string {
  const country = asCountryCode(settings.get('country')?.value as string);
  const normalised = normalisePhone(phone, country);
  if (!normalised.ok) throw reservationErrors.phoneInvalid('phone');
  return normalised.e164;
}

const holdMinutes = (settings: ResolvedSettings) =>
  settings.get('reservations.waitlistHoldMinutes')?.value as number;

function today(settings: ResolvedSettings, now: Date) {
  const timeZone = settings.get('timezone')?.value as string;
  return zonedDayBounds(zonedParts(now, timeZone).date, timeZone);
}
