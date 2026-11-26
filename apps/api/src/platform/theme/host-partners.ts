import { Inject, Injectable, Logger } from '@nestjs/common';
import { normalizeHost } from '@durby/shared';
import { DEFAULT_PARTNER } from '../provisioning';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../tenancy';
import { THEME_SNAPSHOT_TTL_MS } from './theme.service';

interface Snapshot {
  byHost: ReadonlyMap<string, string>;
  defaultPartnerId: string | null;
}

/**
 * Which partner a request's host belongs to (ADR 0085): a `partner_domains` hostname names its partner; any other
 * host is the default partner (Durby). Public pages that act for an organization answer only on its own partner's
 * domain, so a Durby restaurant is never shown under another partner's brand. Domains change only by migration, so
 * a snapshot refreshed every few minutes is enough, and a lookup never queries the database.
 */
@Injectable()
export class HostPartners {
  private readonly logger = new Logger(HostPartners.name);
  private snapshot: Snapshot = { byHost: new Map(), defaultPartnerId: null };
  private loadedAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;

  constructor(
    @Inject(PLATFORM_PRISMA)
    private readonly prisma: Pick<
      PlatformPrismaClient,
      'partnerDomain' | 'partner' | 'organization'
    >,
  ) {}

  /** The partner behind `rawHost`; null only while the default partner can't be read. */
  async partnerFor(rawHost: string | undefined): Promise<string | null> {
    if (Date.now() - this.loadedAt >= THEME_SNAPSHOT_TTL_MS) await this.refresh();
    const host = normalizeHost(rawHost);
    return (
      (host === null ? undefined : this.snapshot.byHost.get(host)) ?? this.snapshot.defaultPartnerId
    );
  }

  /** The organization belongs to the partner of `rawHost`. */
  async serves(rawHost: string | undefined, organizationId: string): Promise<boolean> {
    const [partnerId, organization] = await Promise.all([
      this.partnerFor(rawHost),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { partnerId: true },
      }),
    ]);
    return partnerId !== null && organization?.partnerId === partnerId;
  }

  /** One refresh at a time; on failure the previous snapshot stays. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.load()
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.loadedAt = Date.now();
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'host_partners.refresh_failed');
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async load(): Promise<Snapshot> {
    const [domains, fallback] = await Promise.all([
      this.prisma.partnerDomain.findMany({ select: { hostname: true, partnerId: true } }),
      this.prisma.partner.findUnique({
        where: { slug: DEFAULT_PARTNER.slug },
        select: { id: true },
      }),
    ]);
    return {
      byHost: new Map(domains.map((d) => [d.hostname, d.partnerId])),
      defaultPartnerId: fallback?.id ?? null,
    };
  }
}
