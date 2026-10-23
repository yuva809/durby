import { Inject, Injectable } from '@nestjs/common';
import { eventSchema } from '@durby/shared';
import { UnrecoverableError } from 'bullmq';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';
import { OutboxHandlerRegistry } from './handler-registry';
import type { HandlerJobData } from './outbox-queue';
import { OUTBOX_SYSTEM_USER_ID } from './system-actor';

export type RunOutcome = 'applied' | 'duplicate';

/**
 * Runs one handler job (ADR 0013 §5): in the event's tenant context and one transaction, insert
 * processed_events (handler, event_id) ON CONFLICT DO NOTHING; if it already existed, stop; else run
 * the handler with the same `tx`. Its effects and the dedupe row commit or roll back together.
 * A concurrent duplicate waits on the unique index and then conflicts.
 */
@Injectable()
export class OutboxEventRunner {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly registry: OutboxHandlerRegistry,
  ) {}

  run(job: HandlerJobData): Promise<RunOutcome> {
    const handler = this.registry.handler(job.handler);
    // A newer release's handler, picked up during a rollout: retried until a worker knows it.
    if (!handler) throw new Error(`Unknown outbox handler ${job.handler}`);
    const parsed = eventSchema(job.type, job.version)?.safeParse(job.payload);
    if (!parsed?.success) {
      throw new UnrecoverableError(`Invalid payload of ${job.type} v${job.version}`);
    }
    const event = {
      id: job.eventId,
      tenantId: job.tenantId,
      type: job.type,
      version: job.version,
      payload: parsed.data,
      occurredAt: new Date(job.occurredAt),
    };
    return this.tenantContext.run({ tenantId: job.tenantId, userId: OUTBOX_SYSTEM_USER_ID }, () =>
      this.db.$transaction(async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO processed_events (tenant_id, handler, event_id)
          VALUES (${job.tenantId}::uuid, ${job.handler}, ${job.eventId}::uuid)
          ON CONFLICT DO NOTHING`;
        if (inserted === 0) return 'duplicate';
        await handler.fn(event, tx);
        return 'applied';
      }),
    );
  }
}
