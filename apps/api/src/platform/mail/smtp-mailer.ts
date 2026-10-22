import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config';
import type { Mailer, MailMessage } from './mailer';

/** SMTP delivery (Mailpit locally and on staging). */
@Injectable()
export class SmtpMailer implements Mailer, OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // No logger/debug options: nodemailer would log message contents.
    this.transport = createTransport(config.SMTP_URL);
    this.from = config.MAIL_FROM;
  }

  async send(message: MailMessage): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({ from: this.from, ...message });
    return { messageId: info.messageId };
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
