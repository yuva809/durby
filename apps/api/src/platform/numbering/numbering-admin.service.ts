import { Inject, Injectable } from '@nestjs/common';
import {
  calendarMonthIn,
  formatNumber,
  isNumberSeriesKey,
  NUMBER_SERIES,
  NUMBER_SERIES_KEYS,
  type NumberFormat,
  numberFormatProblems,
  type NumberSeries,
  type NumberSeriesKey,
  numberingPeriod,
  type PatchNumberSeriesRequest,
  type PutNumberSeriesCounterRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../audit';
import { Clock } from '../auth';
import { EntitlementService } from '../config/entitlements';
import { SettingsService } from '../config/settings';
import { AccessService } from '../rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import { numberingErrors } from './numbering-errors';
import { ensureCounter, lockSeries, type StoredSeries } from './series-store';

const MANAGE = 'platform.settings.manage';

/**
 * Reads and edits the organization's number series (docs/platform/numbering.md → API). Each
 * change and its audit row are written in one tenant transaction; no-ops write nothing. Series
 * are organization-wide: writes need `platform.settings.manage` for all locations.
 */
@Injectable()
export class NumberingAdmin {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly entitlements: EntitlementService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Series of enabled features, registry order, for the current period. Creates nothing. */
  async list(): Promise<NumberSeries[]> {
    const enabled: NumberSeriesKey[] = [];
    for (const key of NUMBER_SERIES_KEYS) {
      if (await this.entitlements.isEnabled(NUMBER_SERIES[key].feature)) enabled.push(key);
    }
    return this.db.$transaction(async (tx) => {
      const stored = await tx.numberSeries.findMany({
        where: { key: { in: [...enabled] } },
        select: SERIES_SELECT,
      });
      const byKey = new Map(stored.map((row) => [row.key, row as StoredSeries]));
      const now = await this.now(tx);
      const result: NumberSeries[] = [];
      for (const key of enabled) {
        const series = byKey.get(key);
        result.push(await this.view(tx, key, series ?? null, now));
      }
      return result;
    });
  }

  /** Changes prefix, pattern and/or reset policy; returns the series. */
  async update(rawKey: string, patch: PatchNumberSeriesRequest): Promise<NumberSeries> {
    const key = requireKey(rawKey);
    await this.access.assert(MANAGE);
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      const before = await lockSeries(tx, tenantId, key, 'update');
      const next: NumberFormat = {
        prefix: patch.prefix ?? before.prefix,
        pattern: patch.pattern ?? before.pattern,
        resetPolicy: patch.resetPolicy ?? before.resetPolicy,
      };
      const problems = numberFormatProblems(next);
      if (problems.includes('prefix_invalid'))
        throw numberingErrors.invalidPrefix(['prefix_invalid']);
      if (problems.length > 0) throw numberingErrors.invalidPattern(problems);
      const now = await this.now(tx);
      if (
        next.prefix === before.prefix &&
        next.pattern === before.pattern &&
        next.resetPolicy === before.resetPolicy
      ) {
        return this.view(tx, key, before, now);
      }
      if (next.resetPolicy !== before.resetPolicy && (await hasIssued(tx, before.id))) {
        throw numberingErrors.seriesInUse(key);
      }
      const row = await tx.numberSeries.update({
        where: { id: before.id },
        data: next,
        select: SERIES_SELECT,
      });
      const after = row as StoredSeries;
      await this.audit.record(tx, {
        action: 'platform.number_series.updated',
        actor: auditActor.user(userId),
        entityId: after.id,
        before: seriesSnapshot(before),
        after: seriesSnapshot(after),
      });
      return this.view(tx, key, after, now);
    });
  }

  /** Raises the counter of a period (default: the current one); returns the series. */
  async raiseCounter(rawKey: string, body: PutNumberSeriesCounterRequest): Promise<NumberSeries> {
    const key = requireKey(rawKey);
    await this.access.assert(MANAGE);
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      // Share: allocations may continue; a reset policy change waits.
      const series = await lockSeries(tx, tenantId, key, 'share');
      const now = await this.now(tx);
      const current = numberingPeriod(series.resetPolicy, now.year);
      const period = body.period ?? current;
      const fits =
        series.resetPolicy === 'never'
          ? period === current
          : /^[0-9]{4}$/.test(period) && Number(period) >= now.year;
      if (!fits) throw numberingErrors.invalidPeriod(period);

      const created = await ensureCounter(tx, tenantId, series.id, period);
      const [counter] = await tx.$queryRaw<{ id: string; nextValue: bigint }[]>`
        SELECT id::text AS id, next_value AS "nextValue" FROM number_series_counters
        WHERE tenant_id = ${tenantId}::uuid AND series_id = ${series.id}::uuid AND period = ${period}
        FOR UPDATE`;
      if (!counter) throw new Error(`Counter of ${key} (${period}) missing after creation`);
      const stored = BigInt(counter.nextValue);
      const wanted = BigInt(body.nextValue);
      if (wanted < stored) throw numberingErrors.counterBackwards(period, stored.toString());
      if (wanted > stored) {
        await tx.numberSeriesCounter.update({
          where: { id: counter.id },
          data: { nextValue: wanted },
        });
        const view = (nextValue: bigint) =>
          snapshot('number_series_counter', {
            id: counter.id,
            seriesKey: key,
            period,
            nextValue: nextValue.toString(),
          });
        await this.audit.record(tx, {
          action: 'platform.number_series_counter.raised',
          actor: auditActor.user(userId),
          entityId: counter.id,
          // A counter created just now held the default 1, like no counter at all.
          before: created ? null : view(stored),
          after: view(wanted),
        });
      }
      return this.view(tx, key, series, now);
    });
  }

  private async now(tx: TenantTransactionClient): Promise<CalendarNow> {
    const timeZone = await this.settings.get('timezone', {}, tx);
    return calendarMonthIn(this.clock.now(), timeZone);
  }

  /** The series (registry defaults when not stored yet) at the current period. */
  private async view(
    tx: TenantTransactionClient,
    key: NumberSeriesKey,
    stored: StoredSeries | null,
    now: CalendarNow,
  ): Promise<NumberSeries> {
    const def = NUMBER_SERIES[key];
    const series = stored ?? {
      prefix: def.prefix,
      pattern: def.pattern,
      resetPolicy: def.resetPolicy,
    };
    const period = numberingPeriod(series.resetPolicy, now.year);
    const counter = stored
      ? await tx.numberSeriesCounter.findUnique({
          where: {
            tenantId_seriesId_period: {
              tenantId: this.tenantContext.require().tenantId,
              seriesId: stored.id,
              period,
            },
          },
          select: { nextValue: true },
        })
      : null;
    const nextValue = counter?.nextValue ?? 1n;
    return {
      key,
      prefix: series.prefix,
      pattern: series.pattern,
      resetPolicy: series.resetPolicy,
      period,
      nextValue: nextValue.toString(),
      preview: formatNumber(series.pattern, {
        prefix: series.prefix,
        year: now.year,
        month: now.month,
        sequence: nextValue,
      }),
    };
  }
}

interface CalendarNow {
  year: number;
  month: number;
}

const SERIES_SELECT = {
  id: true,
  key: true,
  prefix: true,
  pattern: true,
  resetPolicy: true,
} as const;

function requireKey(key: string): NumberSeriesKey {
  if (!isNumberSeriesKey(key)) throw numberingErrors.unknownKey(key);
  return key;
}

async function hasIssued(tx: TenantTransactionClient, seriesId: string): Promise<boolean> {
  return (await tx.numberSeriesCounter.count({ where: { seriesId, nextValue: { gt: 1 } } })) > 0;
}

function seriesSnapshot(row: StoredSeries) {
  return snapshot('number_series', {
    id: row.id,
    key: row.key,
    prefix: row.prefix,
    pattern: row.pattern,
    resetPolicy: row.resetPolicy,
  });
}
