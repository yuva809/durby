/** Injection token for the {@link Mailer}. */
export const MAILER = Symbol('MAILER');

export interface MailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** E.g. a booking's calendar file (R2.4). */
  attachments?: MailAttachment[];
}

/**
 * Sends one email. Implementations never log subjects, bodies or recipients: bodies carry
 * single-use links. The real provider comes later behind this interface.
 */
export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}
