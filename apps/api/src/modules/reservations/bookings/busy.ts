import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import type { TenantTransactionClient } from '../../../platform/tenancy';
import { reservationErrors } from '../reservations-errors';

/**
 * How long a booking write waits for a row lock (a concurrent booking of the same table, the
 * number series counter) before it gives up with `503 reservations.busy`: shorter than Prisma's 5 s
 * transaction timeout, so the wait ends cleanly (docs/modules/reservations.md → R1.6, load).
 */
export const BOOKING_LOCK_TIMEOUT = '3s';

/** First statement of a booking write transaction. */
export async function shortLockWaits(tx: TenantTransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${BOOKING_LOCK_TIMEOUT}'`);
}

/**
 * Overload, not a bug: no pooled connection in time or the interactive transaction expired
 * (Prisma P2028), a lock wait past `lock_timeout` (Postgres 55P03), or a deadlock Postgres resolved
 * by aborting this transaction (40P01: the table rows' exclusion wait against the counter row).
 */
export function isBusy(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: unknown; message?: unknown } | null;
  if (e?.code === 'P2028') return true;
  const message = typeof e?.message === 'string' ? e.message : '';
  const text = `${message} ${JSON.stringify(e?.meta ?? null)}`;
  return (
    text.includes('55P03') ||
    text.includes('lock timeout') ||
    text.includes('40P01') ||
    text.includes('deadlock detected')
  );
}

/**
 * Turns overload into `503 reservations.busy` with Retry-After instead of a 500. 5xx answers are
 * never stored by the idempotency layer, so retrying with the same key runs the write again.
 */
@Injectable()
export class ReservationsBusyInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() => (isBusy(error) ? reservationErrors.busy() : error)),
        ),
      );
  }
}
