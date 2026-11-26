import { Inject, Injectable, Logger } from '@nestjs/common';
import { DEFAULT_LOCALE, isLocale } from '@durby/i18n';
import type { EventPayload, ReservationStatus } from '@durby/shared';
import { generateToken, hashToken, inviteLinkBase } from '../../../platform/auth';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { SettingsService } from '../../../platform/config/settings';
import { LabelService } from '../../../platform/labels';
import { MAILER, type Mailer, type MailMessage } from '../../../platform/mail';
import { OnEvent, type OutboxEvent } from '../../../platform/outbox';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TenantContext,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { bookingIcs } from './ics';

type Template = 'booked' | 'pending' | 'requested' | 'declined' | 'expired' | 'cancelled';

/** Changes into `booked` that the guest hears about (not e.g. undoing an arrival). */
const BOOKED_FROM: readonly (ReservationStatus | null)[] = [
  null,
  'requested',
  'pending',
  'cancelled',
];

/**
 * Emails to the guest about their booking (docs/modules/reservations.md → Mail, R2.4): booked (with a calendar
 * file), pending and request received, declined, expired, cancelled (with the calendar's cancellation). Sent by the
 * worker after the change committed; the event's status must still be the booking's, so an old event never sends a
 * wrong email. Each email with a link carries a new manage token (only its hash is kept). Walk-ins, guests without
 * an email and erased guests get nothing. Logs the template and message id only.
 */
@Injectable()
export class GuestMailHandler {
  private readonly logger = new Logger(GuestMailHandler.name);

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PLATFORM_PRISMA) private readonly platform: PlatformPrismaClient,
    private readonly labels: LabelService,
    private readonly settings: SettingsService,
    private readonly tenantContext: TenantContext,
  ) {}

  @OnEvent('reservations.reservation.created', { handler: 'reservations.mailOnCreated' })
  created(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.mail(event, tx);
  }

  @OnEvent('reservations.reservation.status_changed', {
    handler: 'reservations.mailOnStatusChanged',
  })
  statusChanged(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    return this.mail(event, tx);
  }

  private async mail(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    const payload = event.payload as EventPayload<'reservations.reservation.created'>;
    const booking = await tx.reservation.findUnique({
      where: { id: payload.reservationId },
      select: {
        id: true,
        number: true,
        status: true,
        source: true,
        partySize: true,
        startsAt: true,
        endsAt: true,
        locationId: true,
        guest: { select: { name: true, email: true, locale: true, anonymisedAt: true } },
        location: { select: { name: true, address: true } },
        changes: {
          select: { fromStatus: true, toStatus: true },
          orderBy: { id: 'desc' },
        },
      },
    });
    if (!booking || booking.status !== payload.status) return; // a later event speaks for it
    if (booking.source === 'walk_in') return;
    const { email, name, locale, anonymisedAt } = booking.guest;
    if (!email || anonymisedAt !== null) return;
    const latest = booking.changes[0];
    const template = templateFor(booking.status, latest?.fromStatus ?? null, event.type);
    if (!template) return;

    const { tenantId } = this.tenantContext.require();
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, partnerId: true },
    });
    const base = await this.linkBase(organization.partnerId);
    const page = await tx.reservationBookingPage.findFirst({
      where: { locationId: booking.locationId, enabled: true },
      select: { slug: true },
    });
    const branches = await tx.location.count({
      where: { archivedAt: null, isWarehouseSite: false },
    });
    const restaurant =
      branches > 1 ? `${organization.name} (${booking.location.name})` : organization.name;
    const lang = isLocale(locale) ? locale : DEFAULT_LOCALE;
    const t = await this.labels.translator(lang);
    const resolved = await this.settings.all({ locationId: booking.locationId }, tx);
    const timeZone = resolved.get('timezone')?.value as string;
    const when = new Intl.DateTimeFormat(lang, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(booking.startsAt);

    let manageLink = '';
    if (template === 'booked' || template === 'pending' || template === 'requested') {
      const secret = generateToken();
      await tx.reservationManageToken.create({
        data: { tenantId, reservationId: booking.id, tokenHash: hashToken(secret) },
      });
      manageLink = `${base}/b/manage#${tenantId}.${secret}`;
    }
    const params = {
      name: name ?? '',
      restaurant,
      when,
      party: booking.partySize,
      number: booking.number,
      manageLink,
      bookAgain: page ? `${base}/b/${page.slug}` : base,
      address: booking.location.address ?? booking.location.name,
    };
    const message: MailMessage = {
      to: email,
      subject: t(`reservations.email.${template}.subject`, params),
      text: t(`reservations.email.${template}.body`, params),
    };
    if (template === 'booked' || template === 'cancelled') {
      const ics = bookingIcs({
        method: template === 'booked' ? 'PUBLISH' : 'CANCEL',
        uid: `${booking.id}@${new URL(base).hostname}`,
        sequence: booking.changes.length,
        start: booking.startsAt,
        end: booking.endsAt,
        stamp: new Date(),
        summary: t('reservations.email.calendarSummary', params),
        location: `${restaurant}, ${params.address}`,
        description: t('reservations.email.calendarDescription', params),
      });
      const method = template === 'booked' ? 'PUBLISH' : 'CANCEL';
      message.attachments = [
        {
          filename: template === 'booked' ? 'booking.ics' : 'cancellation.ics',
          content: ics,
          contentType: `text/calendar; charset=utf-8; method=${method}`,
        },
      ];
    }
    const { messageId } = await this.mailer.send(message);
    this.logger.log({ template: `reservations.${template}`, messageId }, 'guest mail sent');
  }

  /** The organization's partner domain when the web runs there, else WEB_BASE_URL (as invitation links). */
  private async linkBase(partnerId: string): Promise<string> {
    const domains = await this.platform.partnerDomain.findMany({
      where: { partnerId },
      select: { hostname: true },
    });
    return inviteLinkBase(
      this.config.WEB_ORIGINS,
      this.config.WEB_BASE_URL,
      domains.map((d) => d.hostname),
    ).replace(/\/$/, '');
  }
}

function templateFor(
  status: ReservationStatus,
  from: ReservationStatus | null,
  type: string,
): Template | null {
  switch (status) {
    case 'booked':
      return BOOKED_FROM.includes(from) ? 'booked' : null;
    case 'pending':
      return type === 'reservations.reservation.created' ? 'pending' : null;
    case 'requested':
      return type === 'reservations.reservation.created' ? 'requested' : null;
    case 'declined':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}
