import { NUMBER_SERIES, type NumberResetPolicy, type NumberSeriesKey } from '@durby/shared';
import { Prisma } from '../database/generated/client';
import type { TenantTransactionClient } from '../tenancy';

export interface StoredSeries {
  id: string;
  key: NumberSeriesKey;
  prefix: string;
  pattern: string;
  resetPolicy: NumberResetPolicy;
}

/**
 * Creates the missing series of `keys` from the registry defaults (`ON CONFLICT DO NOTHING`), so
 * concurrent first uses never fail on the unique key. Not audited (ADR 0012 §4).
 */
export async function ensureSeries(
  tx: TenantTransactionClient,
  tenantId: string,
  keys: readonly NumberSeriesKey[],
): Promise<void> {
  await tx.numberSeries.createMany({
    data: keys.map((key) => {
      const { prefix, pattern, resetPolicy } = NUMBER_SERIES[key];
      return { tenantId, key, prefix, pattern, resetPolicy };
    }),
    skipDuplicates: true,
  });
}

/**
 * The series of `key`, created from the registry if missing, row-locked until the end of `tx`:
 * `share` for allocations and counter raises (they don't change the definition), `update` for
 * edits, which then wait for in-flight allocations and block new ones.
 */
export async function lockSeries(
  tx: TenantTransactionClient,
  tenantId: string,
  key: NumberSeriesKey,
  mode: 'share' | 'update',
): Promise<StoredSeries> {
  await ensureSeries(tx, tenantId, [key]);
  const lock = mode === 'share' ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`;
  const [row] = await tx.$queryRaw<StoredSeries[]>`
    SELECT id::text AS id, key, prefix, pattern, reset_policy::text AS "resetPolicy"
    FROM number_series
    WHERE tenant_id = ${tenantId}::uuid AND key = ${key}
    ${lock}`;
  if (!row) throw new Error(`Number series ${key} missing after creation`);
  return row;
}

/** Creates the period's counter at 1 if missing; true when this call created it. */
export async function ensureCounter(
  tx: TenantTransactionClient,
  tenantId: string,
  seriesId: string,
  period: string,
): Promise<boolean> {
  const { count } = await tx.numberSeriesCounter.createMany({
    data: [{ tenantId, seriesId, period }],
    skipDuplicates: true,
  });
  return count === 1;
}
