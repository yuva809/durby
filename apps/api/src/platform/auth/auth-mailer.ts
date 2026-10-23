import { Inject, Injectable } from '@nestjs/common';
import { createTranslator, DEFAULT_LOCALE, isLocale, type LabelKey } from '@durby/i18n';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';
import { MAILER, type Mailer } from '../mail';

export type AuthMailTemplate = 'reset' | 'verify';

const PAGES: Record<AuthMailTemplate, string> = {
  reset: '/reset-password',
  verify: '/verify-email',
};

/**
 * Password-reset and verification emails. User-level (no organization), so bundled default labels
 * in the user's locale (docs/platform/labels.md → Backend t()). The token goes into the URL fragment, which browsers
 * never send to servers, so it cannot reach access logs, proxies or Referer headers. Logs only
 * the template and message id.
 */
@Injectable()
export class AuthMailer {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthMailer.name);
  }

  async send(template: AuthMailTemplate, to: string, locale: string, token: string): Promise<void> {
    const t = createTranslator(isLocale(locale) ? locale : DEFAULT_LOCALE);
    const link = `${new URL(PAGES[template], this.config.WEB_BASE_URL).toString()}#token=${token}`;
    const { messageId } = await this.mailer.send({
      to,
      subject: t(`auth.email.${template}.subject` as LabelKey),
      text: t(`auth.email.${template}.body` as LabelKey, { link }),
    });
    this.logger.info({ template: `auth.${template}`, messageId }, 'auth mail sent');
  }
}
