/** Injection token for the {@link Mailer}. */
export const MAILER = Symbol('MAILER');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends one email. Implementations never log subjects, bodies or recipients: bodies carry
 * single-use links. The real provider comes later behind this interface.
 */
export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}
