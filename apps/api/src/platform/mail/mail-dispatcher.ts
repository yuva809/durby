import { Injectable, Logger } from '@nestjs/common';
import { mailErrorFields } from './mail-error';

/** How long a request waits for its mail before answering anyway. */
export const MAIL_WAIT_MS = 3_000;

export type MailOutcome = 'sent' | 'failed' | 'pending';

/**
 * Sends the mail of a request that has already committed its data. The request waits at most
 * `waitMs` for the send; a send that is slower keeps running in the background. A failure never
 * reaches the caller (the data is saved and the mail can be sent again): it is logged with
 * {@link mailErrorFields} only, under `event`.
 */
@Injectable()
export class MailDispatcher {
  private readonly logger = new Logger(MailDispatcher.name);

  async dispatch(
    event: string,
    send: () => Promise<unknown>,
    waitMs: number = MAIL_WAIT_MS,
  ): Promise<MailOutcome> {
    const attempt = Promise.resolve()
      .then(send)
      .then(
        (): MailOutcome => 'sent',
        (error: unknown): MailOutcome => {
          this.logger.error({ event, err: mailErrorFields(error) }, 'mail failed');
          return 'failed';
        },
      );
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<MailOutcome>((resolve) => {
      timer = setTimeout(() => resolve('pending'), waitMs);
    });
    try {
      return await Promise.race([attempt, budget]);
    } finally {
      clearTimeout(timer);
    }
  }
}
