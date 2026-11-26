import { Inject, Injectable } from '@nestjs/common';
import {
  bookingPagePath,
  type BookingPage,
  type BookingPageResponse,
  type PutBookingPageRequest,
  suggestBookingSlug,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../../platform/audit';
import { EntitlementService } from '../../../platform/config/entitlements';
import { AccessService } from '../../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
} from '../../../platform/tenancy';
import { reservationErrors } from '../reservations-errors';
import { readableLocation } from '../setup/table-rules.service';

const SELECT = { id: true, locationId: true, slug: true, enabled: true } as const;
type Row = { id: string; locationId: string; slug: string; enabled: boolean };

/**
 * A location's online booking page (docs/modules/reservations.md → R2.1, ADR 0085): its slug and whether it takes
 * bookings. Read with `reservations.bookings.read`, changed with `reservations.setup.edit` at the location.
 */
@Injectable()
export class BookingPagesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async get(locationId: string): Promise<BookingPageResponse> {
    await readableLocation(asTenantDb(this.db), this.access, locationId);
    const [row, online, suggestedSlug] = await Promise.all([
      this.db.reservationBookingPage.findUnique({
        where: { tenantId_locationId: { tenantId: this.tenantId(), locationId } },
        select: SELECT,
      }),
      this.entitlements.isEnabled('reservations.online'),
      this.suggestion(locationId),
    ]);
    return { page: row ? toPage(row, online) : null, suggestedSlug, online };
  }

  async put(body: PutBookingPageRequest): Promise<BookingPage> {
    const tenantId = this.tenantId();
    const { userId } = this.tenantContext.require();
    await readableLocation(asTenantDb(this.db), this.access, body.locationId);
    await this.access.assert('reservations.setup.edit', { locationId: body.locationId });
    const online = await this.entitlements.isEnabled('reservations.online');
    const row = await this.db.$transaction(async (tx) => {
      const before = await tx.reservationBookingPage.findUnique({
        where: { tenantId_locationId: { tenantId, locationId: body.locationId } },
        select: SELECT,
      });
      if (before && before.slug === body.slug && before.enabled === body.enabled) return before;
      // Another organization's slug is invisible here (RLS), so ask the one function that sees every slug.
      const [owner] = await tx.$queryRaw<{ tenant_id: string; location_id: string }[]>`
        SELECT tenant_id, location_id FROM booking_page_by_slug(${body.slug})`;
      if (owner && !(owner.tenant_id === tenantId && owner.location_id === body.locationId)) {
        throw reservationErrors.bookingSlugTaken();
      }
      const after = await taken(() =>
        tx.reservationBookingPage.upsert({
          where: { tenantId_locationId: { tenantId, locationId: body.locationId } },
          create: { tenantId, locationId: body.locationId, slug: body.slug, enabled: body.enabled },
          update: { slug: body.slug, enabled: body.enabled },
          select: SELECT,
        }),
      );
      await this.audit.record(tx, {
        action: 'reservations.booking_page.updated',
        actor: auditActor.user(userId),
        entityId: after.id,
        ...(before && { before: pageSnapshot(before) }),
        after: pageSnapshot(after),
      });
      return after;
    });
    return toPage(row, online);
  }

  private tenantId(): string {
    return this.tenantContext.require().tenantId;
  }

  /** The organization's name, with the location's when it has several. */
  private async suggestion(locationId: string): Promise<string> {
    const [organization, locations] = await Promise.all([
      this.db.organization.findUniqueOrThrow({
        where: { id: this.tenantId() },
        select: { name: true },
      }),
      this.db.location.findMany({
        where: { archivedAt: null, isWarehouseSite: false },
        select: { id: true, name: true },
      }),
    ]);
    const location = locations.find((l) => l.id === locationId);
    return locations.length > 1 && location
      ? suggestBookingSlug(organization.name, location.name)
      : suggestBookingSlug(organization.name);
  }
}

const toPage = (row: Row, online: boolean): BookingPage => ({
  locationId: row.locationId,
  slug: row.slug,
  enabled: row.enabled,
  path: bookingPagePath(row.slug),
  online,
});

const pageSnapshot = (row: Row) => snapshot('reservation_booking_page', row);

/** Two organizations racing for one slug: the unique index decides, the loser gets 409. */
async function taken<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const e = error as { code?: string; meta?: { target?: unknown } } | null;
    if (e?.code === 'P2002') throw reservationErrors.bookingSlugTaken();
    throw error;
  }
}
