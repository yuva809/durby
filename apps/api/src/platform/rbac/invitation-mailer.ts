import { Inject, Injectable, Logger } from '@nestjs/common';
import { DEFAULT_LOCALE, isLocale } from '@durby/i18n';
import { APP_CONFIG, type AppConfig } from '../config';
import { MAILER, type Mailer } from '../mail';
import { inviteLinkBase } from './invitation-link';
import { INVITATION_LABELS, type InvitationLabels } from './invitation-ports';

/**
 * Invitation emails, with the inviting organization's labels: call inside its tenant context. The
 * text comes from labels organizations can't override (ADR 0011 §2). The token goes into the URL fragment, which browsers never send to servers,
 * so it cannot reach access logs, proxies or Referer headers. Logs only the template and message id.
 */
@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(INVITATION_LABELS) private readonly labels: InvitationLabels,
  ) {}

  /**
   * The accept link of a token: on the organization's partner domain if one is an allowed web
   * origin, else WEB_BASE_URL (web-shell.md → Invitation links). The token is in the fragment,
   * never sent to a server or logged.
   */
  linkFor(token: string, partnerHostnames: readonly string[]): string {
    const base = inviteLinkBase(
      this.config.WEB_ORIGINS,
      this.config.WEB_BASE_URL,
      partnerHostnames,
    );
    return `${new URL('/accept-invite', base).toString()}#token=${token}`;
  }

  /** `partnerHostnames`: the organization's partner domains, which pick the link's origin. */
  async send(input: {
    to: string;
    locale: string;
    organizationName: string;
    token: string;
    partnerHostnames: readonly string[];
  }) {
    const t = await this.labels.translator(isLocale(input.locale) ? input.locale : DEFAULT_LOCALE);
    const link = this.linkFor(input.token, input.partnerHostnames);
    const params = { organization: input.organizationName, link };
    const { messageId } = await this.mailer.send({
      to: input.to,
      subject: t('platform.email.invite.subject', params),
      text: t('platform.email.invite.body', params),
    });
    this.logger.log({ template: 'platform.invite', messageId }, 'invitation mail sent');
  }
}
