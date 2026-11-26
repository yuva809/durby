import { Inject, Injectable, Logger } from '@nestjs/common';
import { DEFAULT_LOCALE, isLocale } from '@durby/i18n';
import { LabelService } from '../../../platform/labels';
import { MAILER, type Mailer } from '../../../platform/mail';

export interface TableReadyNotice {
  to: string;
  locale: string;
  name: string;
  restaurant: string;
  holdMinutes: number;
}

/**
 * Tells a guest that their table is ready (ADR 0084 §3). Email today; SMS becomes another method
 * here. Call inside the tenant's context. Logs only the template and the message id.
 */
@Injectable()
export class GuestNotifier {
  private readonly logger = new Logger(GuestNotifier.name);

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly labels: LabelService,
  ) {}

  async email(notice: TableReadyNotice): Promise<void> {
    const t = await this.labels.translator(
      isLocale(notice.locale) ? notice.locale : DEFAULT_LOCALE,
    );
    const params = {
      name: notice.name,
      restaurant: notice.restaurant,
      minutes: notice.holdMinutes,
    };
    const { messageId } = await this.mailer.send({
      to: notice.to,
      subject: t('reservations.email.tableReady.subject', params),
      text: t('reservations.email.tableReady.body', params),
    });
    this.logger.log({ template: 'reservations.tableReady', messageId }, 'waitlist mail sent');
  }
}
