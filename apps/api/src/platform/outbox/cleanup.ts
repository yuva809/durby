import { Inject, Injectable } from '@nestjs/common';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import { OUTBOX_SYSTEM_USER_ID } from './system-actor';

const DAY_MS = 24 * 3600 * 1000;
export const PUBLISHED_RETENTION_DAYS = 7;
export const PROCESSED_RETENTION_DAYS = 30;
/** Rows deleted per table and tenant per run; the rest goes next hour. */
const BATCH = 10_000;
const ORG_PAGE = 500;

export interface CleanupCounts {
  events: number;
  processed: number;
  /** Rows of other retention tasks (e.g. expired idempotency keys), by task name. */
  [task: string]: number;
}

/** Extra per-tenant retention work run in the same pass (platform/idempotency registers one). */
export interface RetentionTask {
  name: string;
  run(tx: TenantTransactionClient, now: Date): Promise<number>;
}

/**
 * Retention (ADR 0013 §8): published events after 7 days, processed_events after 30 days, plus
 * registered tasks. Pending and dead-lettered events are never deleted. Runs per organization
 * (platform client lists them; organizations has no RLS), each in its own tenant transaction.
 */
@Injectable()
export class OutboxCleanup {
  private readonly tasks: RetentionTask[] = [];

  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platform: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
  ) {}

  register(task: RetentionTask): void {
    this.tasks.push(task);
  }

  async runOnce(now: Date = new Date()): Promise<CleanupCounts> {
    const totals: CleanupCounts = { events: 0, processed: 0 };
    for (const task of this.tasks) totals[task.name] = 0;
    let cursor: string | undefined;
    for (;;) {
      const orgs = await this.platform.organization.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: ORG_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const { id } of orgs) {
        const counts = await this.tenant(id, now);
        for (const [key, n] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + n;
      }
      if (orgs.length < ORG_PAGE) return totals;
      cursor = orgs[orgs.length - 1]?.id;
    }
  }

  private tenant(tenantId: string, now: Date): Promise<CleanupCounts> {
    const published = new Date(now.getTime() - PUBLISHED_RETENTION_DAYS * DAY_MS);
    const processed = new Date(now.getTime() - PROCESSED_RETENTION_DAYS * DAY_MS);
    return this.tenantContext.run({ tenantId, userId: OUTBOX_SYSTEM_USER_ID }, () =>
      this.db.$transaction(async (tx) => {
        const counts: CleanupCounts = {
          events: await tx.$executeRaw`
            DELETE FROM outbox_events WHERE id IN (
              SELECT id FROM outbox_events
              WHERE tenant_id = ${tenantId}::uuid AND published_at < ${published}
              LIMIT ${BATCH})`,
          processed: await tx.$executeRaw`
            DELETE FROM processed_events WHERE id IN (
              SELECT id FROM processed_events
              WHERE tenant_id = ${tenantId}::uuid AND processed_at < ${processed}
              LIMIT ${BATCH})`,
        };
        for (const task of this.tasks) counts[task.name] = await task.run(tx, now);
        return counts;
      }),
    );
  }
}
