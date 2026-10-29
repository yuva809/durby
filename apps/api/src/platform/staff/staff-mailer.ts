import { Inject, Injectable } from '@nestjs/common';
import { createTranslator } from '@durby/i18n';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';
import { MAILER, type Mailer } from '../mail';

/**
 * Staff invitation emails (set a password). Default English labels (staff aren't tied to an organization or locale).
 * The token goes into the URL fragment, which never reaches servers or logs.
 */
@Injectable()
export class StaffMailer {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StaffMailer.name);
  }

  async sendInvitation(to: string, token: string): Promise<void> {
    const t = createTranslator('en');
    const link = `${new URL('/platform/accept', this.config.WEB_BASE_URL).toString()}#token=${token}`;
    const { messageId } = await this.mailer.send({
      to,
      subject: t('staff.email.invite.subject'),
      text: t('staff.email.invite.body', { link }),
    });
    this.logger.info({ template: 'staff.invite', messageId }, 'staff mail sent');
  }
}
