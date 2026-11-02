/**
 * Overload, not a bug (ADR 0021): the request waited too long for the database. Prisma P2028 (no
 * pooled connection within `maxWait`, or the interactive transaction ran past its `timeout`),
 * Postgres 55P03 (a lock wait past `lock_timeout`) and 40P01 (a deadlock Postgres resolved by
 * aborting this transaction). Answered `503 platform.busy` with Retry-After; retrying with the same
 * Idempotency-Key is safe because 5xx answers are never stored.
 */
export type OverloadKind = 'pool_or_transaction_timeout' | 'lock_timeout' | 'deadlock';

/** Seconds a client should wait before retrying a busy answer. */
export const BUSY_RETRY_AFTER_SECONDS = 2;

export function overloadKind(error: unknown): OverloadKind | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { code?: unknown; meta?: unknown; message?: unknown };
  if (e.code === 'P2028') return 'pool_or_transaction_timeout';
  const message = typeof e.message === 'string' ? e.message : '';
  const text = `${message} ${JSON.stringify(e.meta ?? null)}`;
  if (text.includes('55P03') || text.includes('lock timeout')) return 'lock_timeout';
  if (text.includes('40P01') || text.includes('deadlock detected')) return 'deadlock';
  return null;
}
