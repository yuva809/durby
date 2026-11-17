import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  defaultPreference,
  type EventPayload,
  NOTIFICATION_SETTINGS_PATH,
  type NotificationKind,
  notificationPath,
} from '@durby/shared';
import { DEFAULT_LOCALE, isLocale, type LabelKey, type Translator } from '@durby/i18n';
import { mailLinkBase, UserDirectory } from '../auth';
import { APP_CONFIG, type AppConfig } from '../config';
import { LabelService } from '../labels';
import { MAILER, type Mailer, mailErrorFields } from '../mail';
import { OnEvent, type OutboxEvent } from '../outbox';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';

/** `request_submitted` → `requestSubmitted`: label keys are camelCase. */
const camel = (value: string) => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The one-line text of a notification, as the bell shows it. */
export function notificationText(
  t: Translator,
  n: { kind: string; params: Record<string, string> },
): string {
  const params = { ...n.params };
  if (params.status) {
    params.status = t(`platform.notifications.feedbackStatus.${params.status}` as LabelKey);
  }
  return t(`platform.notifications.kinds.${camel(n.kind)}` as LabelKey, params);
}

/**
 * Sends stored notifications by email (and push, step 3) to the people who chose that for the kind (docs/platform/
 * notifications.md, ADR 0047). Runs in the worker for `platform.notification.created`, in the organization's tenant
 * context: its labels, the person's language, links on its partner domain. Best effort per person: a failed send is
 * logged (never the address or text) and the bell still has it; the event is not retried for it.
 */
@Injectable()
export class NotificationDeliveryHandler {
  private readonly logger = new Logger(NotificationDeliveryHandler.name);

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    private readonly labels: LabelService,
    private readonly users: UserDirectory,
  ) {}

  @OnEvent('platform.notification.created', { handler: 'platform.deliverNotifications' })
  async deliver(event: OutboxEvent, tx: TenantTransactionClient): Promise<void> {
    const { notificationIds } = event.payload as EventPayload<'platform.notification.created'>;
    const rows = await tx.notification.findMany({
      where: { id: { in: notificationIds } },
      select: {
        id: true,
        userId: true,
        kind: true,
        entityType: true,
        entityId: true,
        params: true,
      },
    });
    if (rows.length === 0) return;
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [prefs, profiles, org] = await Promise.all([
      tx.notificationPreference.findMany({
        where: { userId: { in: userIds }, kind: { in: [...new Set(rows.map((r) => r.kind))] } },
        select: { userId: true, kind: true, email: true },
      }),
      this.users.profiles(userIds),
      this.platformDb.organization.findUniqueOrThrow({
        where: { id: event.tenantId },
        select: { name: true, partner: { select: { domains: { select: { hostname: true } } } } },
      }),
    ]);
    const emailChoice = new Map(prefs.map((p) => [`${p.userId}:${p.kind}`, p.email]));
    const base = mailLinkBase(this.config.WEB_ORIGINS, this.config.WEB_BASE_URL, {
      partnerHostnames: org.partner.domains.map((d) => d.hostname),
    });
    const translators = new Map<string, Promise<Translator>>();
    const translator = (locale: string) => {
      const key = isLocale(locale) ? locale : DEFAULT_LOCALE;
      if (!translators.has(key)) translators.set(key, this.labels.translator(key));
      return translators.get(key)!;
    };

    for (const row of rows) {
      const kind = row.kind as NotificationKind;
      const wantsEmail = emailChoice.get(`${row.userId}:${kind}`) ?? defaultPreference(kind).email;
      const profile = profiles.get(row.userId);
      if (!wantsEmail || !profile) continue;
      const t = await translator(profile.locale);
      const text = notificationText(t, {
        kind,
        params: (row.params ?? {}) as Record<string, string>,
      });
      const path = notificationPath({
        kind,
        entityType: row.entityType as never,
        entityId: row.entityId,
      });
      const params = {
        text,
        organization: org.name,
        link: path ? new URL(path, base).toString() : '',
        settingsLink: new URL(NOTIFICATION_SETTINGS_PATH, base).toString(),
      };
      try {
        const { messageId } = await this.mailer.send({
          to: profile.email,
          subject: t('platform.email.notification.subject', params),
          text: t(
            path ? 'platform.email.notification.body' : 'platform.email.notification.bodyNoLink',
            params,
          ),
        });
        this.logger.log(
          { template: 'platform.notification', kind, messageId },
          'notification mail sent',
        );
      } catch (error) {
        this.logger.error(
          { template: 'platform.notification', kind, err: mailErrorFields(error) },
          'notification mail failed',
        );
      }
    }
  }
}
