import { Injectable } from '@nestjs/common';
import {
  calendarMonthIn,
  formatNumber,
  isNumberSeriesKey,
  NUMBER_SERIES_KEYS,
  type NumberSeriesKey,
  numberingPeriod,
} from '@durby/shared';
import { Clock } from '../auth';
import { SettingsService } from '../config/settings';
import { TenantContext, type TenantTransactionClient } from '../tenancy';
import { ensureCounter, ensureSeries, lockSeries } from './series-store';

export interface AllocatedNumber {
  /** The rendered number, e.g. `INV-2026-000042`. */
  number: string;
  /** `all` or the year, in the organization's time zone. */
  period: string;
  sequence: bigint;
}

/**
 * Gap-free document numbers (docs/platform/numbering.md → Allocation). Allocates inside the
 * caller's transaction: the number exists if and only if that transaction commits.
 */
@Injectable()
export class NumberingService {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /**
   * The next number of `key` for the current tenant. **Call it as late as possible in `tx`**: the
   * counter row stays locked until commit, so every other allocation in the series and period
   * waits for the rest of the transaction. `at` (default now) picks the period and the date tokens.
   */
  async next(
    key: NumberSeriesKey,
    tx: TenantTransactionClient,
    opts: { at?: Date } = {},
  ): Promise<AllocatedNumber> {
    if (!isNumberSeriesKey(key)) throw new Error(`Unregistered number series: ${String(key)}`);
    const { tenantId } = this.tenantContext.require();
    // With tx: never a second pooled connection while this transaction may hold counter locks.
    const timeZone = await this.settings.get('timezone', {}, tx);
    const { year, month } = calendarMonthIn(opts.at ?? this.clock.now(), timeZone);
    const series = await lockSeries(tx, tenantId, key, 'share');
    const period = numberingPeriod(series.resetPolicy, year);
    await ensureCounter(tx, tenantId, series.id, period);
    // Same row lock as SELECT … FOR UPDATE, in one statement; READ COMMITTED re-reads the row
    // after a concurrent allocator commits, so values are consecutive.
    const [row] = await tx.$queryRaw<{ value: bigint }[]>`
      UPDATE number_series_counters
      SET next_value = next_value + 1, updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid AND series_id = ${series.id}::uuid AND period = ${period}
      RETURNING next_value - 1 AS value`;
    if (!row) throw new Error(`Counter of ${key} (${period}) missing after creation`);
    const sequence = BigInt(row.value);
    return {
      number: formatNumber(series.pattern, { prefix: series.prefix, year, month, sequence }),
      period,
      sequence,
    };
  }

  /** Creates every registered series the current tenant lacks (provisioning). */
  ensureAll(tx: TenantTransactionClient): Promise<void> {
    return ensureSeries(tx, this.tenantContext.require().tenantId, NUMBER_SERIES_KEYS);
  }
}
