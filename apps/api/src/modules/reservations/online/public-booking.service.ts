import { Inject, Injectable } from '@nestjs/common';
import {
  bookingSlugSchema,
  type PublicAvailability,
  type PublicAvailabilityQuery,
  type PublicBookingPage,
  type SettingKey,
} from '@durby/shared';
import { AuthRateLimits, Clock } from '../../../platform/auth';
import { EntitlementService } from '../../../platform/config/entitlements';
import { SettingsService } from '../../../platform/config/settings';
import { HostPartners } from '../../../platform/theme';
import {
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
} from '../../../platform/tenancy';
import { AvailabilityLoader } from '../availability/loader';
import { reservationErrors } from '../reservations-errors';

/** No user reads the public page; RLS and audit only need an id (as the QR menu, ADR 0026). */
const ANONYMOUS = '00000000-0000-0000-0000-000000000000';

interface Page {
  tenantId: string;
  locationId: string;
}

/**
 * The public booking page (docs/modules/reservations.md → R2.1, ADR 0085). The organization comes from the slug,
 * never from the request; the page answers only when it is on, its location is in service, the organization has
 * `reservations.online` and belongs to the partner of the request's domain. Anything else is the same 404.
 */
@Injectable()
export class PublicBookingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(PLATFORM_PRISMA) private readonly platform: PlatformPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly limits: AuthRateLimits,
    private readonly hosts: HostPartners,
    private readonly entitlements: EntitlementService,
    private readonly settings: SettingsService,
    private readonly loader: AvailabilityLoader,
    private readonly clock: Clock,
  ) {}

  page(slug: string, host: string | undefined, ip: string): Promise<PublicBookingPage> {
    return this.within(slug, host, ip, async (page) => {
      const [organization, location, resolved] = await Promise.all([
        this.db.organization.findUniqueOrThrow({
          where: { id: page.tenantId },
          select: { name: true },
        }),
        this.db.location.findUniqueOrThrow({
          where: { id: page.locationId },
          select: { name: true },
        }),
        this.settings.all({ locationId: page.locationId }),
      ]);
      const value = (key: SettingKey) => resolved.get(key)?.value;
      const instant = value('reservations.online.instantMaxParty');
      return {
        restaurant: organization.name,
        location: location.name,
        timeZone: value('timezone') as string,
        locale: value('locale') as PublicBookingPage['locale'],
        currency: value('currency') as string,
        instantMaxParty: typeof instant === 'number' ? instant : null,
      };
    });
  }

  availability(
    slug: string,
    query: PublicAvailabilityQuery,
    host: string | undefined,
    ip: string,
  ): Promise<PublicAvailability> {
    return this.within(slug, host, ip, async (page) => {
      const result = await this.loader.load({
        locationId: page.locationId,
        date: query.date,
        partySize: query.partySize,
        channel: 'online',
        now: this.clock.now(),
      });
      // Times and status only: no tables, combinations or reasons leave the restaurant.
      return {
        date: result.date,
        closed: result.closed,
        turnMinutes: result.turnMinutes,
        slots: result.slots.map((s) => ({ start: s.start, end: s.end, status: s.status })),
      };
    });
  }

  private async within<T>(
    slug: string,
    host: string | undefined,
    ip: string,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const parsed = bookingSlugSchema.safeParse(slug);
    // A malformed slug counts against the address like any other, but never reaches the database.
    await this.limits.enforce([this.limits.rules.publicBookingIp, ip]);
    if (parsed.success)
      await this.limits.enforce([this.limits.rules.publicBookingPage, parsed.data]);
    if (!parsed.success) throw reservationErrors.bookingPageNotFound();
    const [found] = await this.platform.$queryRaw<
      { tenant_id: string; location_id: string; enabled: boolean }[]
    >`SELECT tenant_id, location_id, enabled FROM booking_page_by_slug(${parsed.data})`;
    if (!found?.enabled || !(await this.hosts.serves(host, found.tenant_id))) {
      throw reservationErrors.bookingPageNotFound();
    }
    const page = { tenantId: found.tenant_id, locationId: found.location_id };
    return this.tenantContext.run({ tenantId: page.tenantId, userId: ANONYMOUS }, async () => {
      const location = await this.db.location.findUnique({
        where: { id: page.locationId },
        select: { archivedAt: true },
      });
      if (!location || location.archivedAt !== null) throw reservationErrors.bookingPageNotFound();
      if (!(await this.entitlements.isEnabled('reservations.online'))) {
        throw reservationErrors.bookingPageNotFound();
      }
      return fn(page);
    });
  }
}
