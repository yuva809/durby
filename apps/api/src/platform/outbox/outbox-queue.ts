import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventType } from '@durby/shared';
import { type JobsOptions, Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config';

/** One BullMQ queue for all handler jobs. */
export const OUTBOX_QUEUE = 'durby-outbox';

/** Data of one handler job: an event for one handler. Ids, keys and enums only (ADR 0013 §2). */
export interface HandlerJobData {
  eventId: string;
  tenantId: string;
  type: EventType;
  version: number;
  payload: Record<string, unknown>;
  occurredAt: string;
  handler: string;
}

/** `<eventId>@<handler>`: BullMQ drops a second job with the same id while it is retained. */
export function handlerJobId(eventId: string, handler: string): string {
  return `${eventId}@${handler}`;
}

/** Handler retries (ADR 0013 §5); failed jobs stay 30 days for the CLI. */
export const HANDLER_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
} as const satisfies JobsOptions;

/** A publish that hasn't finished by then counts as failed: the claim transaction holds locks. */
const PUBLISH_TIMEOUT_MS = 5_000;

/** Redis connection for BullMQ: its own connections, with the retry settings BullMQ requires. */
export function bullConnection(config: AppConfig) {
  return { url: config.REDIS_URL, maxRetriesPerRequest: null };
}

/**
 * Enqueues handler jobs. The queue connects lazily on first use, so the api process (which only
 * writes events) never opens a BullMQ connection. Tests replace it to simulate Redis failures.
 */
@Injectable()
export class OutboxPublisher implements OnModuleDestroy {
  private current: Queue<HandlerJobData> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  queue(): Queue<HandlerJobData> {
    this.current ??= new Queue<HandlerJobData>(OUTBOX_QUEUE, {
      // Fail fast while Redis is down: the dispatcher backs off instead of queueing in memory.
      connection: { ...bullConnection(this.config), enableOfflineQueue: false },
      defaultJobOptions: HANDLER_JOB_OPTIONS,
    });
    return this.current;
  }

  async publish(jobs: readonly HandlerJobData[]): Promise<void> {
    if (jobs.length === 0) return;
    const adding = this.queue().addBulk(
      jobs.map((data) => ({
        name: data.type,
        data,
        opts: { jobId: handlerJobId(data.eventId, data.handler) },
      })),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`publish timed out after ${PUBLISH_TIMEOUT_MS} ms`)),
        PUBLISH_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([adding, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.current?.close();
  }
}
