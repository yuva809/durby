import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTranslator, DEFAULT_LOCALE, type Locale, LOCALES } from '@durby/i18n';
import { APP_CONFIG, type AppConfig } from '../config';
import { MAILER, type Mailer } from '../mail';

const toLocale = (locale: string): Locale =>
  (LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : DEFAULT_LOCALE;

/**
 * Invitation emails. The token goes into the URL fragment, which browsers never send to servers,
 * so it cannot reach access logs, proxies or Referer headers. Logs only the template and message id.
 */
@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async send(input: { to: string; locale: string; organizationName: string; token: string }) {
    const t = createTranslator(toLocale(input.locale));
    const link = `${new URL('/accept-invite', this.config.WEB_BASE_URL).toString()}#token=${input.token}`;
    const fill = (text: string) =>
      text.replace('{organization}', input.organizationName).replace('{link}', link);
    const { messageId } = await this.mailer.send({
      to: input.to,
      subject: fill(t('platform.email.invite.subject')),
      text: fill(t('platform.email.invite.body')),
    });
    this.logger.log({ template: 'platform.invite', messageId }, 'invitation mail sent');
  }
}
