import { Inject, Injectable } from '@nestjs/common';
import { auditActor, AuditService, snapshot } from '../audit';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
} from '../tenancy';
import { OutboxPublisher } from './outbox-queue';
import { OUTBOX_SYSTEM_USER_ID } from './system-actor';

export interface DeadLetter {
  id: string;
  organizationId: string;
  type: string;
  version: number;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: Date;
}

export interface HandlerFailure {
  jobId: string;
  eventId: string;
  organizationId: string;
  type: string;
  handler: string;
  attempts: number;
  failedReason: string;
  failedAt: Date | null;
}

export class OutboxAdminError extends Error {
  readonly code = 'outbox.admin_input';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Operator tools behind the `outbox` CLI (docs/platform/outbox.md → CLI): list and retry
 * dead-lettered events and handler jobs that exhausted their retries. Retries are audited as
 * `platform.outbox_event.retried` (actor cli.outbox) in the event's tenant.
 */
@Injectable()
export class OutboxAdmin {
  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platform: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly publisher: OutboxPublisher,
  ) {}

  /** Dead-lettered events of one organization, or of all (one query per organization). */
  async deadLetters(organizationId?: string): Promise<DeadLetter[]> {
    const orgs = organizationId
      ? [requireUuid(organizationId)]
      : (
          await this.platform.organization.findMany({
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        ).map((o) => o.id);
    const all: DeadLetter[] = [];
    for (const org of orgs) {
      const rows = await this.asOrg(org, () =>
        this.db.outboxEvent.findMany({
          where: { deadLetteredAt: { not: null } },
          select: {
            id: true,
            type: true,
            version: true,
            attempts: true,
            lastError: true,
            deadLetteredAt: true,
          },
          orderBy: { deadLetteredAt: 'asc' },
        }),
      );
      all.push(
        ...rows.map((r) => ({
          ...r,
          organizationId: org,
          deadLetteredAt: r.deadLetteredAt as Date,
        })),
      );
    }
    return all;
  }

  /** Puts a dead-lettered event back in line: attempts reset, due now. */
  async retry(organizationId: string, eventId: string): Promise<void> {
    requireUuid(eventId);
    await this.asOrg(requireUuid(organizationId), () =>
      this.db.$transaction(async (tx) => {
        const before = await tx.outboxEvent.findFirst({
          where: { id: eventId, deadLetteredAt: { not: null } },
          select: { id: true, type: true, version: true, attempts: true, deadLetteredAt: true },
        });
        if (!before)
          throw new OutboxAdminError(`No dead-lettered event ${eventId} in ${organizationId}`);
        await tx.$executeRaw`
          UPDATE outbox_events
          SET dead_lettered_at = NULL, attempts = 0, last_error = NULL, available_at = now()
          WHERE id = ${eventId}::uuid`;
        await this.audit.record(tx, {
          action: 'platform.outbox_event.retried',
          actor: auditActor.system('cli.outbox'),
          entityId: eventId,
          before: snapshot('outbox_event', before),
          after: snapshot('outbox_event', { ...before, attempts: 0, deadLetteredAt: null }),
        });
      }),
    );
  }

  /** Handler jobs that exhausted their retries (newest first, at most 200). */
  async handlerFailures(): Promise<HandlerFailure[]> {
    const jobs = await this.publisher.queue().getFailed(0, 199);
    return jobs.map((job) => ({
      jobId: job.id ?? '',
      eventId: job.data.eventId,
      organizationId: job.data.tenantId,
      type: job.data.type,
      handler: job.data.handler,
      attempts: job.attemptsMade,
      failedReason: job.failedReason,
      failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    }));
  }

  /** Re-queues one failed handler job; audited in the job's tenant before it runs again. */
  async retryHandler(jobId: string): Promise<void> {
    const job = await this.publisher.queue().getJob(jobId);
    if (!job || !(await job.isFailed())) throw new OutboxAdminError(`No failed job ${jobId}`);
    const { eventId, tenantId, type, version, handler } = job.data;
    await this.asOrg(tenantId, () =>
      this.db.$transaction(async (tx) => {
        await this.audit.record(tx, {
          action: 'platform.outbox_event.retried',
          actor: auditActor.system('cli.outbox'),
          entityId: eventId,
          after: snapshot('outbox_event', { id: eventId, type, version, handler }),
        });
        // Inside the transaction: if the retry fails, no audit row claims it happened.
        await job.retry('failed');
      }),
    );
  }

  private asOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return this.tenantContext.run({ tenantId: organizationId, userId: OUTBOX_SYSTEM_USER_ID }, fn);
  }
}

function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new OutboxAdminError(`Not a uuid: ${value}`);
  return value;
}
