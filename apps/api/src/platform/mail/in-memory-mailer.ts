import { v7 as uuidv7 } from 'uuid';
import type { Mailer, MailMessage } from './mailer';

/** Test double: keeps sent messages in memory. */
export class InMemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** Tests: every send rejects with this error until it is set back to null. */
  failWith: Error | null = null;
  /** Tests: every send stays pending forever (an unreachable SMTP server). */
  hangs = false;

  send(message: MailMessage): Promise<{ messageId: string }> {
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.hangs) return new Promise(() => undefined);
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
