import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';
import { OutboxDispatcher } from './dispatcher';

export interface OutboxLag {
  due: number;
  pending: number;
  tenants: number;
  oldestPendingSeconds: number;
}

/**
 * Outbox lag as a log (ADR 0013 §10): `outbox.lag` every 30 s, `warn` above
 * OUTBOX_LAG_WARN_SECONDS. Deliberately not part of /api/v1/health: a degraded health on lag
 * would fail the deploy's post-check and roll back a healthy api.
 */
@Injectable()
export class OutboxLagReporter {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('outbox');
  }

  /** Totals over every tenant's pending events (outbox_backlog), not just the due tenants. */
  async measure(now: Date = new Date()): Promise<OutboxLag> {
    const totals = await this.dispatcher.backlogTotals();
    const oldest = totals.oldestPendingAt?.getTime();
    return {
      due: totals.due,
      pending: totals.pending,
      tenants: totals.tenants,
      oldestPendingSeconds:
        oldest === undefined ? 0 : Math.max(0, Math.round((now.getTime() - oldest) / 1000)),
    };
  }

  async report(): Promise<OutboxLag> {
    const lag = await this.measure();
    const fields = { event: 'outbox.lag', ...lag };
    if (lag.oldestPendingSeconds > this.config.OUTBOX_LAG_WARN_SECONDS) {
      this.logger.warn(fields, 'outbox.lag');
    } else {
      this.logger.info(fields, 'outbox.lag');
    }
    return lag;
  }
}
