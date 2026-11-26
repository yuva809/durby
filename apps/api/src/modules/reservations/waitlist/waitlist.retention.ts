import { Injectable, type OnModuleInit } from '@nestjs/common';
import { OPEN_WAITLIST_STATUSES, WAITLIST_KEEP_HOURS } from '@durby/shared';
import { auditActor, AuditService } from '../../../platform/audit';
import { OutboxCleanup, OutboxService } from '../../../platform/outbox';
import type { TenantTransactionClient } from '../../../platform/tenancy';
import { ENTRY_SELECT, entrySnapshot } from './waitlist-row';

/** Entries per organization and pass; the rest goes next hour. */
const BATCH = 1_000;

/**
 * The hourly pass over the waitlist (ADR 0084 §5), per organization in its own transaction: an entry
 * open for 24 hours counts as left, and an entry that ended 24 hours ago loses its contact data.
 */
@Injectable()
export class WaitlistRetention implements OnModuleInit {
  constructor(
    private readonly cleanup: OutboxCleanup,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.cleanup.register({ name: 'waitlist', run: (tx, now) => this.run(tx, now) });
  }

  async run(tx: TenantTransactionClient, now: Date): Promise<number> {
    const limit = new Date(now.getTime() - WAITLIST_KEEP_HOURS * 3_600_000);
    // One cheap look first: the pass runs for every organization, most have nothing to do.
    const [due] = await tx.$queryRaw<{ open: boolean; ended: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "waitlist_entries"
                      WHERE "status" IN ('waiting', 'notified') AND "created_at" < ${limit}) AS "open",
             EXISTS (SELECT 1 FROM "waitlist_entries"
                      WHERE "erased_at" IS NULL AND "ended_at" < ${limit}) AS "ended"`;
    return (
      (due?.open ? await this.expire(tx, now, limit) : 0) +
      (due?.ended ? await this.erase(tx, now, limit) : 0)
    );
  }

  private async expire(tx: TenantTransactionClient, now: Date, limit: Date): Promise<number> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "waitlist_entries"
       WHERE "status" IN ('waiting', 'notified') AND "created_at" < ${limit}
       ORDER BY "created_at", "id"
       LIMIT ${BATCH}
       FOR UPDATE SKIP LOCKED`;
    const entries = await tx.waitlistEntry.findMany({
      where: {
        id: { in: locked.map((row) => row.id) },
        status: { in: [...OPEN_WAITLIST_STATUSES] },
      },
      select: ENTRY_SELECT,
    });
    for (const before of entries) {
      const after = await tx.waitlistEntry.update({
        where: { id: before.id },
        data: { status: 'left', endedAt: now },
        select: ENTRY_SELECT,
      });
      await this.audit.record(tx, {
        action: 'reservations.waitlist_entry.expired',
        actor: auditActor.system('job.waitlist'),
        entityId: before.id,
        before: entrySnapshot(before),
        after: entrySnapshot(after),
      });
      await this.outbox.add(tx, {
        type: 'reservations.waitlist.changed',
        payload: { entryId: before.id, locationId: before.locationId },
      });
    }
    return entries.length;
  }

  private erase(tx: TenantTransactionClient, now: Date, limit: Date): Promise<number> {
    return tx.$executeRaw`
      UPDATE "waitlist_entries"
         SET "name" = NULL, "phone" = NULL, "email" = NULL, "note" = NULL,
             "erased_at" = ${now}, "updated_at" = ${now}
       WHERE "id" IN (SELECT "id" FROM "waitlist_entries"
                       WHERE "erased_at" IS NULL AND "ended_at" < ${limit}
                       LIMIT ${BATCH}
                       FOR UPDATE SKIP LOCKED)`;
  }
}
