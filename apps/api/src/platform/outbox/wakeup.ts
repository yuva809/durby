import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config';

/** Notified by OutboxService.add in the event's own statement; delivered only on commit. */
export const OUTBOX_CHANNEL = 'durby_outbox';

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Wakes the outbox worker when an event commits (ADR 0044 §5): LISTEN on a dedicated connection
 * (DATABASE_URL, outside the pool, so it never takes a pool slot), reconnecting with backoff when it
 * drops. Meanwhile the worker's idle backoff (1 s → 5 s) still finds every event. Worker only.
 */
@Injectable()
export class OutboxWakeup implements OnApplicationShutdown {
  private client: pg.Client | undefined;
  private onWake: (() => void) | undefined;
  private stopped = false;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private ready: Promise<void> = new Promise(() => undefined);
  private markReady: () => void = () => undefined;
  private isReady = true;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('outbox');
  }

  /** Starts listening; resolves once LISTEN is active (retrying until it is). */
  listen(onWake: () => void): Promise<void> {
    this.onWake = onWake;
    this.stopped = false;
    this.notReady();
    void this.connect();
    return this.ready;
  }

  /** Resolves when LISTEN is active again (after a drop). */
  listening(): Promise<void> {
    return this.ready;
  }

  /** Tests: ends the connection as a network drop would. */
  async dropConnectionForTest(): Promise<void> {
    this.notReady();
    await this.client?.end();
  }

  /** From now on listening() waits for the next successful LISTEN. */
  private notReady(): void {
    if (!this.isReady) return;
    this.isReady = false;
    this.ready = new Promise((resolve) => {
      this.markReady = () => {
        this.isReady = true;
        resolve();
      };
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.config.DATABASE_URL });
    this.client = client;
    let dropped = false;
    const drop = (error?: Error) => {
      if (dropped) return;
      dropped = true;
      if (this.client === client) this.client = undefined;
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      this.logger.warn(
        { event: 'outbox.listen_dropped', error: error?.message, retryMs: this.retryMs },
        'outbox.listen_dropped',
      );
      this.notReady();
      this.retryTimer = setTimeout(() => void this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
    client.on('error', drop);
    client.on('end', () => drop());
    client.on('notification', (message) => {
      if (message.channel === OUTBOX_CHANNEL) this.onWake?.();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
    } catch (error) {
      drop(error as Error);
      return;
    }
    if (dropped || this.stopped) return;
    this.retryMs = RETRY_MIN_MS;
    this.logger.info({ event: 'outbox.listen_started' }, 'outbox.listen_started');
    this.markReady();
    // Anything committed while we weren't listening: one pass now.
    this.onWake?.();
  }
}
