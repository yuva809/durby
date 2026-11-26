import { Injectable, type OnModuleInit } from '@nestjs/common';
import { auditActor, AuditService, snapshot } from '../../../platform/audit';
import { SettingsService } from '../../../platform/config/settings';
import { OutboxCleanup } from '../../../platform/outbox';
import type { TenantTransactionClient } from '../../../platform/tenancy';
import { eraseGuest } from './guests.service';

/** Guests erased per organization and pass; the rest goes next hour. */
const BATCH = 500;

/**
 * Automatic erasure of guests' personal data after the retention period (docs/modules/reservations.md → GDPR,
 * Retention; Q8, R2.5). The worker's hourly pass, per organization in its own transaction: a guest is due when the
 * latest of their last visit, their latest booking's end and their own creation lies `reservations.guestRetentionMonths`
 * back, and nothing of theirs is still to come. A new booking or visit moves that by itself. Erased like a request
 * (`eraseGuest`), audited as `job.guest_retention`.
 */
@Injectable()
export class GuestRetention implements OnModuleInit {
  constructor(
    private readonly cleanup: OutboxCleanup,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.cleanup.register({ name: 'guestRetention', run: (tx, now) => this.run(tx, now) });
  }

  async run(tx: TenantTransactionClient, now: Date): Promise<number> {
    const resolved = await this.settings.all({}, tx);
    const months = resolved.get('reservations.guestRetentionMonths')?.value as number;
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT g.id
        FROM reservation_guests g
        LEFT JOIN LATERAL (
          SELECT max(r.ends_at) AS last_end,
                 bool_or(r.status IN ('requested', 'pending', 'booked', 'arrived', 'seated')
                         AND r.ends_at > ${now}) AS ahead
            FROM reservations r
           WHERE r.guest_id = g.id
        ) b ON true
       WHERE g.anonymised_at IS NULL
         AND NOT coalesce(b.ahead, false)
         AND greatest(g.last_visit_at, b.last_end, g.created_at)
             < ${now}::timestamptz - make_interval(months => ${months})
       ORDER BY greatest(g.last_visit_at, b.last_end, g.created_at), g.id
       LIMIT ${BATCH}
       FOR UPDATE OF g SKIP LOCKED`;
    for (const { id } of due) {
      await eraseGuest(tx, id, now);
      await this.audit.record(tx, {
        action: 'reservations.guest.anonymised',
        actor: auditActor.system('job.guest_retention'),
        entityId: id,
        before: snapshot('reservation_guest', { id, anonymisedAt: null }),
        after: snapshot('reservation_guest', { id, anonymisedAt: now }),
      });
    }
    return due.length;
  }
}
