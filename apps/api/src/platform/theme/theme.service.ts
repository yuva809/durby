import { Logger } from '@nestjs/common';
import type { ThemeResponse } from '@durby/shared';
import type { PlatformPrismaClient } from '../tenancy';
import { buildThemeSnapshot, type ThemeSnapshot, themeForHost } from './theme-snapshot';

/** Themes change only by migration and deploy (ADR 0015 §3), so a few minutes of staleness is fine. */
export const THEME_SNAPSHOT_TTL_MS = 5 * 60_000;

/**
 * Partner themes by request host (docs/platform/web-shell.md → Resolution). All domains load into
 * one snapshot, so memory is bounded by `partner_domains`, never by the hosts clients send, and a
 * lookup never queries the database.
 */
/** Provided by ThemeModule's factory (the clock is a test seam, not a dependency). */
export class ThemeService {
  private readonly logger = new Logger(ThemeService.name);
  private snapshot: ThemeSnapshot = new Map();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly prisma: Pick<PlatformPrismaClient, 'partnerDomain'>,
    private readonly now: () => number = Date.now,
  ) {}

  async forHost(rawHost: string | undefined): Promise<ThemeResponse> {
    if (this.now() - this.loadedAt >= THEME_SNAPSHOT_TTL_MS) await this.refresh();
    return themeForHost(this.snapshot, rawHost);
  }

  /** One refresh at a time; on failure the previous snapshot stays (empty → default theme). */
  private refresh(): Promise<void> {
    this.refreshing ??= this.load()
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.loadedAt = this.now();
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'theme.snapshot_refresh_failed');
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async load(): Promise<ThemeSnapshot> {
    const rows = await this.prisma.partnerDomain.findMany({
      select: {
        hostname: true,
        partnerId: true,
        partner: {
          select: {
            theme: {
              select: {
                productName: true,
                logoPath: true,
                colorPrimary: true,
                colorInk: true,
                colorPaper: true,
                navLayout: true,
              },
            },
          },
        },
      },
    });
    return buildThemeSnapshot(
      rows.map((r) => ({ hostname: r.hostname, partnerId: r.partnerId, theme: r.partner.theme })),
      (partnerId) => this.logger.warn({ partnerId }, 'theme.contrast_fallback'),
    );
  }
}
