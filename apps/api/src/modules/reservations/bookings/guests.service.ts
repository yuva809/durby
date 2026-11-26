import { Inject, Injectable } from '@nestjs/common';
import type { AnonymiseGuestResponse } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../../platform/audit';
import { Clock } from '../../../platform/auth';
import { IdempotencyService } from '../../../platform/idempotency';
import { AccessService } from '../../../platform/rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../../platform/tenancy';
import { reservationErrors } from '../reservations-errors';
import { shortLockWaits } from './busy';

/**
 * Erasure on request (docs/modules/reservations.md → GDPR, R1.9): the guest's name, email and phone
 * and their bookings' notes go, also on waitlist entries; the bookings, statuses and counts stay. Irreversible.
 */
@Injectable()
export class GuestsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
  ) {}

  async anonymise(id: string): Promise<AnonymiseGuestResponse> {
    const { userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      await shortLockWaits(tx);
      // One writer per guest: a booking filling its blanks waits, then finds it anonymised.
      const [guest] = await tx.$queryRaw<{ id: string; anonymised_at: Date | null }[]>`
        SELECT id, anonymised_at FROM reservation_guests WHERE id = ${id}::uuid FOR UPDATE`;
      const locations = guest
        ? (
            await tx.reservation.findMany({
              where: { guestId: id },
              select: { locationId: true },
              distinct: ['locationId'],
            })
          ).map((r) => r.locationId)
        : [];
      const readable = await Promise.all(
        locations.map((locationId) =>
          this.access.can('reservations.bookings.read', { locationId }),
        ),
      );
      if (!guest || !readable.some(Boolean)) throw reservationErrors.guestNotFound();
      // Data other branches use too is not one branch manager's to erase.
      for (const locationId of locations) {
        await this.access.assert('reservations.setup.delete', { locationId });
      }

      let anonymisedAt = guest.anonymised_at;
      if (anonymisedAt === null) {
        anonymisedAt = this.clock.now();
        await eraseGuest(tx, id, anonymisedAt);
        await this.audit.record(tx, {
          action: 'reservations.guest.anonymised',
          actor: auditActor.user(userId),
          entityId: id,
          before: snapshot('reservation_guest', { id, anonymisedAt: null }),
          after: snapshot('reservation_guest', { id, anonymisedAt }),
        });
      }
      const response = { id, anonymisedAt: anonymisedAt.toISOString() };
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }
}

/**
 * Erases a guest (GDPR, R1.9; the retention pass, R2.5): name, email and phone, their bookings' notes and manage
 * links, and waitlist entries seated as their bookings (ADR 0084). Bookings, statuses and counts stay. The caller
 * holds the guest's row lock and records the audit row.
 */
export async function eraseGuest(
  tx: TenantTransactionClient,
  id: string,
  anonymisedAt: Date,
): Promise<void> {
  await tx.reservationGuest.update({
    where: { id },
    data: { name: null, email: null, phone: null, anonymisedAt },
  });
  await tx.reservation.updateMany({
    where: { guestId: id },
    data: { guestNote: null, staffNote: null, manageTokenHash: null },
  });
  // The links sent by email (R2.4) stop working.
  await tx.reservationManageToken.deleteMany({ where: { reservation: { guestId: id } } });
  await tx.waitlistEntry.updateMany({
    where: { erasedAt: null, reservation: { guestId: id } },
    data: { name: null, phone: null, email: null, note: null, erasedAt: anonymisedAt },
  });
}
