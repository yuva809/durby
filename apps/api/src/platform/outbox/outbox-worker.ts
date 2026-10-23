import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';
import { OutboxCleanup } from './cleanup';
import { OutboxDispatcher } from './dispatcher';
import { OutboxEventRunner } from './event-runner';
import { OutboxLagReporter } from './lag-reporter';
import { bullConnection, type HandlerJobData, OUTBOX_QUEUE } from './outbox-queue';

/** Touched on every dispatcher pass; the compose healthcheck fails when it is older than 30 s. */
export const HEARTBEAT_FILE = join(tmpdir(), 'worker.alive');

const IDLE_MAX_MS = 5_000;
const LAG_EVERY_MS = 30_000;
const CLEANUP_EVERY_MS = 3_600_000;
const CLEANUP_FIRST_MS = 60_000;

/**
 * The worker process (src/worker.ts, ADR 0013 §9): the dispatcher loop, the BullMQ worker that
 * runs handlers, the lag reporter and hourly cleanup. Never started in the api process.
 */
@Injectable()
export class OutboxWorker implements OnApplicationShutdown {
  private worker: Worker<HandlerJobData> | undefined;
  private timers: NodeJS.Timeout[] = [];
  private loop: Promise<void> | undefined;
  private stopping = false;
  /** Ends the dispatcher loop's current sleep early (shutdown). */
  private wake: (() => void) | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dispatcher: OutboxDispatcher,
    private readonly runner: OutboxEventRunner,
    private readonly lag: OutboxLagReporter,
    private readonly cleanup: OutboxCleanup,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('outbox');
  }

  start(): void {
    this.worker = new Worker<HandlerJobData>(OUTBOX_QUEUE, (job) => this.runner.run(job.data), {
      connection: bullConnection(this.config),
      concurrency: this.config.WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, error) => {
      const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1);
      const fields = {
        event: final ? 'outbox.handler_failed' : 'outbox.handler_retry',
        jobId: job?.id,
        handler: job?.data.handler,
        tenantId: job?.data.tenantId,
        attempts: job?.attemptsMade,
        error: error.message,
      };
      if (final) this.logger.error(fields, fields.event);
      else this.logger.warn(fields, fields.event);
    });
    this.loop = this.dispatchLoop();
    this.every(LAG_EVERY_MS, () => this.lag.report());
    this.timers.push(
      setTimeout(() => {
        void this.cleanupOnce();
        this.every(CLEANUP_EVERY_MS, () => this.cleanupOnce());
      }, CLEANUP_FIRST_MS),
    );
    this.logger.info({ event: 'outbox.worker_started' }, 'outbox.worker_started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.wake?.();
    await this.loop;
    await this.worker?.close();
  }

  private async dispatchLoop(): Promise<void> {
    let idleMs = this.config.OUTBOX_POLL_MS;
    while (!this.stopping) {
      try {
        const result = await this.dispatcher.dispatchOnce();
        idleMs =
          result.claimed > 0 ? this.config.OUTBOX_POLL_MS : Math.min(idleMs * 2, IDLE_MAX_MS);
      } catch (error) {
        this.logger.error(
          { event: 'outbox.dispatch_error', error: (error as Error).message },
          'outbox.dispatch_error',
        );
      }
      await writeFile(HEARTBEAT_FILE, String(Date.now())).catch(() => undefined);
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, idleMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private async cleanupOnce(): Promise<void> {
    try {
      const counts = await this.cleanup.runOnce();
      this.logger.info({ event: 'outbox.cleanup', ...counts }, 'outbox.cleanup');
    } catch (error) {
      this.logger.error(
        { event: 'outbox.cleanup_error', error: (error as Error).message },
        'outbox.cleanup_error',
      );
    }
  }

  private every(ms: number, fn: () => Promise<unknown>): void {
    const timer = setInterval(() => {
      fn().catch((error: unknown) =>
        this.logger.error(
          { event: 'outbox.task_error', error: String(error) },
          'outbox.task_error',
        ),
      );
    }, ms);
    this.timers.push(timer);
  }
}
