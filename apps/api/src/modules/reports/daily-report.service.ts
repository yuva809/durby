import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DailySalesParams } from '@durby/shared';
import { Clock } from '../../platform/auth';
import { EntitlementService } from '../../platform/config/entitlements';
import { SettingsService } from '../../platform/config/settings';
import { NotificationService } from '../../platform/notifications';
import { MemberNames } from '../../platform/rbac';
import {
  asTenantDb,
  PLATFORM_PRISMA,
  type PlatformPrismaClient,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { DayFigures, type DayFiguresResult } from './day-figures';
import { METRIC } from './metrics';
import { dailyReportDue } from './periods';
import { ACTIVE_BRANCHES, ReportPlaces } from './places';

const ORG_PAGE = 100;

/** Nobody caused it: no owner is left out as the one who did. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** A location's name on the message; the rest of a very long one is cut. */
const NAME_MAX = 100;

export type DailyReportResult =
  /** The organization has no reports or no till. */
  | 'off'
  | 'early'
  | 'late'
  /** Dealt with before. */
  | 'done'
  | 'no_orders'
  | 'sent';

/** The daily sales report of the owners (docs/modules/reports.md → Daily report, ADR 0083). Runs in the worker. */
@Injectable()
export class DailyReport {
  private readonly logger = new Logger(DailyReport.name);

  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platform: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly entitlements: EntitlementService,
    private readonly settings: SettingsService,
    private readonly places: ReportPlaces,
    private readonly figures: DayFigures,
    private readonly members: MemberNames,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  /** Every organization; one that fails is logged and tried again at the next pass. */
  async sendDue(now: Date = this.clock.now()): Promise<{ sent: number; failed: number }> {
    const counts = { sent: 0, failed: 0 };
    let cursor: string | undefined;
    for (;;) {
      const orgs = await this.platform.organization.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: ORG_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const { id } of orgs) {
        try {
          if ((await this.send(id, { now })) === 'sent') counts.sent += 1;
        } catch (error) {
          counts.failed += 1;
          this.logger.error(
            {
              event: 'reports.daily_failed',
              tenantId: id,
              error: error instanceof Error ? error.message : 'unknown',
            },
            'reports.daily_failed',
          );
        }
      }
      if (orgs.length < ORG_PAGE) return counts;
      cursor = orgs[orgs.length - 1]?.id;
    }
  }

  /** One organization, at most once per day. `force`: without waiting for the time set (never before the day's end). */
  send(
    tenantId: string,
    { now = this.clock.now(), force = false }: { now?: Date; force?: boolean } = {},
  ): Promise<DailyReportResult> {
    return this.tenantContext.run({ tenantId, userId: SYSTEM_USER_ID }, async () => {
      if (!(await this.entitlements.isEnabled('reports'))) return 'off';
      if (!(await this.entitlements.isEnabled('pos'))) return 'off';
      const timeZone = await this.settings.get('timezone');
      const sendAt = force ? '00:00' : await this.settings.get('reports.dailyReportAt');
      return this.db.$transaction(async (tx) => {
        const places = await this.places.load(ACTIVE_BRANCHES, tx);
        const { day, state } = dailyReportDue(now, {
          timeZone,
          sendAt,
          clocks: places.map((p) => p.clock),
        });
        if (state === 'early' || (state === 'late' && !force)) return state;
        const date = new Date(`${day}T00:00:00Z`);
        const done = await tx.reportDailyMessage.findFirst({ where: { day: date } });
        if (done) return 'done';
        const figures = await this.figures.of(places, () => day, tx);
        // Not marked: the report data may still be on its way (a rebuild after the first release).
        if (figures.total.sales.orders === 0) return 'no_orders';
        // The row decides who sends: a second worker's insert waits for this transaction and then finds it taken.
        const [row] = await tx.reportDailyMessage.createManyAndReturn({
          data: [{ tenantId, day: date }],
          skipDuplicates: true,
          select: { id: true },
        });
        if (!row) return 'done';
        await this.notifications.notify(
          tx,
          {
            userIds: await this.members.owners(asTenantDb(tx)),
            kind: 'daily_sales',
            entityType: 'daily_report',
            entityId: row.id,
            params: { ...paramsOf(day, await this.currency(tx), figures) },
          },
          { actorUserId: null },
        );
        return 'sent';
      });
    });
  }

  private currency(tx: TenantTransactionClient): Promise<string> {
    return this.settings.get('currency', {}, tx);
  }
}

function paramsOf(
  day: string,
  currency: string,
  { places, total }: DayFiguresResult,
): DailySalesParams {
  const [first, ...others] = [...places].sort((a, b) => b.sales.gross.comparedTo(a.sales.gross));
  const percent = total.normal?.changePercent ?? null;
  return {
    day,
    currency,
    gross: METRIC['sales.gross']({ sales: total.sales }),
    orders: String(METRIC['sales.orders']({ sales: total.sales })),
    average: METRIC['sales.averageOrder']({ sales: total.sales }) ?? '0.00',
    ...(percent === null ? {} : { percent }),
    ...(percent !== null && total.leftOut > 0 ? { leftOut: String(total.leftOut) } : {}),
    ...(first && others.length > 0
      ? {
          bestName: first.place.name.slice(0, NAME_MAX),
          bestGross: METRIC['sales.gross']({ sales: first.sales }),
        }
      : {}),
  };
}
