import { Inject, Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config';
import type { Mailer, MailMessage } from './mailer';

/** Injection token for overriding {@link SmtpTimeouts} (tests). */
export const SMTP_TIMEOUTS = Symbol('SMTP_TIMEOUTS');

export interface SmtpTimeouts {
  /** Reaching the server: DNS and TCP/TLS connect. */
  connectionTimeout: number;
  /** The server's greeting (and a STARTTLS upgrade) once connected. */
  greetingTimeout: number;
  /** Silence on an open connection. */
  socketTimeout: number;
}

/**
 * Nodemailer's defaults (2 min connect, 10 min socket) let a blocked port hold a send for minutes.
 * A mail provider answers in well under a second, so a send that needs longer has failed.
 */
export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
};

/** SMTP delivery (Mailpit locally; the configured relay on staging). */
@Injectable()
export class SmtpMailer implements Mailer, OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() @Inject(SMTP_TIMEOUTS) timeouts: SmtpTimeouts = DEFAULT_SMTP_TIMEOUTS,
  ) {
    // No logger/debug options: nodemailer would log message contents.
    this.transport = createTransport({ url: config.SMTP_URL, ...timeouts });
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
