import { Injectable, type OnModuleInit } from '@nestjs/common';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { OutboxCleanup } from '../../platform/outbox';
import type { TenantTransactionClient } from '../../platform/tenancy';

/** Rows stamped per organization and pass; the rest goes next hour (the api shows them as expired meanwhile). */
const BATCH = 1_000;

interface Expired {
  id: string;
  location_id: string;
  printer_id: string;
  kind: string;
  order_id: string;
  ticket_id: string | null;
  attempts: number;
  last_code: string | null;
}

/**
 * The hourly sweep of print jobs past their maximum age (ADR 0033 §12): a pending job whose `expires_at` has passed
 * is stored as needs check with `print.expired`, as the api already shows it, audited as the system. Idempotent: a
 * stamped job is no longer pending. Runs in the worker's retention pass, per organization in its own transaction.
 */
@Injectable()
export class PrintJobSweep implements OnModuleInit {
  constructor(
    private readonly cleanup: OutboxCleanup,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.cleanup.register({ name: 'printJobsExpired', run: (tx, now) => this.run(tx, now) });
  }

  async run(tx: TenantTransactionClient, now: Date): Promise<number> {
    const rows = await tx.$queryRaw<Expired[]>`
      UPDATE "pos_print_jobs" AS j
         SET "status" = 'needs_check', "last_code" = 'print.expired', "completed_at" = ${now},
             "updated_at" = ${now}
        FROM (SELECT "id", "last_code" FROM "pos_print_jobs"
               WHERE "status" = 'pending' AND "expires_at" <= ${now}
               ORDER BY "expires_at", "id"
               LIMIT ${BATCH}
               FOR UPDATE SKIP LOCKED) AS old
       WHERE j."id" = old."id" AND j."status" = 'pending'
      RETURNING j."id", j."location_id", j."printer_id", j."kind", j."order_id", j."ticket_id", j."attempts",
                old."last_code"`;
    for (const row of rows) {
      const fields = {
        id: row.id,
        locationId: row.location_id,
        printerId: row.printer_id,
        kind: row.kind,
        orderId: row.order_id,
        ticketId: row.ticket_id,
        attempts: row.attempts,
      };
      await this.audit.record(tx, {
        action: 'pos.print_job.expired',
        actor: auditActor.system('job.print_jobs'),
        entityId: row.id,
        before: snapshot('print_job', { ...fields, status: 'pending', lastCode: row.last_code }),
        after: snapshot('print_job', {
          ...fields,
          status: 'needs_check',
          lastCode: 'print.expired',
        }),
      });
    }
    return rows.length;
  }
}
