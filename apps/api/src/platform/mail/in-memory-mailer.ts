import { v7 as uuidv7 } from 'uuid';
import type { Mailer, MailMessage } from './mailer';

/** Test double: keeps sent messages in memory. */
export class InMemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return Promise.resolve({ messageId: uuidv7() });
  }

  /** Messages to one recipient, oldest first. */
  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  clear(): void {
    this.sent.length = 0;
  }
}
