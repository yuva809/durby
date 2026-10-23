import { Inject, Injectable } from '@nestjs/common';
import { EVENT_TYPES, type EventType } from '@durby/shared';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import { dispatchBackoffMs } from './backoff';
import { OutboxHandlerRegistry } from './handler-registry';
import { type HandlerJobData, OutboxPublisher } from './outbox-queue';
import { OUTBOX_SYSTEM_USER_ID } from './system-actor';

/** Per tenant: events due now (known types only), all pending, and the oldest pending one. */
export interface TenantBacklog {
  tenantId: string;
  due: number;
  pending: number;
  oldestPendingAt: Date | null;
}

export interface DispatchResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}

const EMPTY: DispatchResult = { claimed: 0, published: 0, failed: 0, deadLettered: 0 };

interface ClaimedRow {
  id: string;
  type: EventType;
  version: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

function add(a: DispatchResult, b: DispatchResult): DispatchResult {
  return {
    claimed: a.claimed + b.claimed,
    published: a.published + b.published,
    failed: a.failed + b.failed,
    deadLettered: a.deadLettered + b.deadLettered,
  };
}

/**
 * Publishes committed events (docs/platform/outbox.md → Dispatcher, ADR 0013 §3–4). The only
 * cross-tenant read is outbox_due_tenants(); each tenant's events are claimed under RLS with
 * FOR UPDATE SKIP LOCKED, enqueued (one job per handler) and marked published in one transaction.
 * A Redis failure backs the batch off and dead-letters after OUTBOX_MAX_ATTEMPTS.
 */
@Injectable()
export class OutboxDispatcher {
  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platform: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenantContext: TenantContext,
    private readonly registry: OutboxHandlerRegistry,
    private readonly publisher: OutboxPublisher,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('outbox');
  }

  /** Tenants with pending events, oldest first (at most 500 per call). */
  async backlog(): Promise<TenantBacklog[]> {
    const rows = await this.platform.$queryRaw<
      { tenantId: string; due: bigint; pending: bigint; oldestPendingAt: Date | null }[]
    >`SELECT tenant_id::text AS "tenantId", due, pending, oldest_pending_at AS "oldestPendingAt"
      FROM outbox_due_tenants(${EVENT_TYPES as string[]}::text[], 500)`;
    return rows.map((r) => ({ ...r, due: Number(r.due), pending: Number(r.pending) }));
  }

  /** One pass over every tenant with due events. */
  async dispatchOnce(): Promise<DispatchResult> {
    let total = EMPTY;
    for (const tenant of await this.backlog()) {
      if (tenant.due === 0) continue;
      total = add(total, await this.dispatchTenant(tenant.tenantId));
    }
    return total;
  }

  /** Claims and publishes up to OUTBOX_BATCH_SIZE due events of one tenant. */
  dispatchTenant(tenantId: string): Promise<DispatchResult> {
    return this.tenantContext.run({ tenantId, userId: OUTBOX_SYSTEM_USER_ID }, () =>
      this.db.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<ClaimedRow[]>`
            SELECT id::text AS id, type, version, payload, occurred_at AS "occurredAt", attempts
            FROM outbox_events
            WHERE published_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()
              AND type = ANY (${EVENT_TYPES as string[]}::text[])
            ORDER BY occurred_at, id
            LIMIT ${this.config.OUTBOX_BATCH_SIZE}
            FOR UPDATE SKIP LOCKED`;
          if (rows.length === 0) return EMPTY;

          const jobs = rows.flatMap((row) => this.jobsOf(tenantId, row));
          try {
            await this.publisher.publish(jobs);
          } catch (error) {
            return this.failed(tx, tenantId, rows, error);
          }
          const ids = rows.map((r) => r.id);
          await tx.$executeRaw`
            UPDATE outbox_events SET published_at = now() WHERE id = ANY (${ids}::uuid[])`;
          return { ...EMPTY, claimed: rows.length, published: rows.length };
        },
        // The publish runs inside: give it room beyond its own timeout.
        { timeout: 15_000 },
      ),
    );
  }

  private jobsOf(tenantId: string, row: ClaimedRow): HandlerJobData[] {
    return this.registry.handlersFor(row.type, row.version).map((handler) => ({
      eventId: row.id,
      tenantId,
      type: row.type,
      version: row.version,
      payload: row.payload,
      occurredAt: row.occurredAt.toISOString(),
      handler: handler.name,
    }));
  }

  private async failed(
    tx: TenantTransactionClient,
    tenantId: string,
    rows: ClaimedRow[],
    error: unknown,
  ): Promise<DispatchResult> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    let deadLettered = 0;
    for (const row of rows) {
      const attempts = row.attempts + 1;
      if (attempts >= this.config.OUTBOX_MAX_ATTEMPTS) {
        deadLettered += 1;
        await tx.$executeRaw`
          UPDATE outbox_events
          SET attempts = ${attempts}, last_error = ${message}, dead_lettered_at = now()
          WHERE id = ${row.id}::uuid`;
      } else {
        const delayMs = dispatchBackoffMs(attempts);
        await tx.$executeRaw`
          UPDATE outbox_events
          SET attempts = ${attempts}, last_error = ${message},
              available_at = now() + make_interval(secs => ${delayMs / 1000})
          WHERE id = ${row.id}::uuid`;
      }
    }
    this.logger.warn(
      {
        event: 'outbox.dispatch_failed',
        tenantId,
        events: rows.length,
        deadLettered,
        error: message,
      },
      'outbox.dispatch_failed',
    );
    return { claimed: rows.length, published: 0, failed: rows.length, deadLettered };
  }
}
