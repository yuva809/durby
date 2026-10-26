import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'durby:idempotent';
export const IDEMPOTENCY_EXEMPT_KEY = 'durby:idempotency-exempt';

export interface IdempotentOptions {
  /**
   * `transaction`: the service stores the result inside its business transaction with
   * IdempotencyService.completeInTransaction(tx, body), so a crash after commit can't lead to a
   * second write (ADR 0014 §6). Required for writes that are not naturally idempotent.
   */
  completion?: 'response' | 'transaction';
}

/**
 * The route requires an Idempotency-Key and replays its stored result for a repeated request
 * (CLAUDE.md rule 8, docs/platform/idempotency.md). Only on @RequirePermission routes.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, { completion: options.completion ?? 'response' });

/** A write route that takes no Idempotency-Key, with the reason (listed in a snapshot test). */
export const IdempotencyExempt = (reason: string) => SetMetadata(IDEMPOTENCY_EXEMPT_KEY, reason);
