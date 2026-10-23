import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { TenantTransactionClient } from '../tenancy';
import { idempotencyErrors } from './idempotency-errors';
import { IdempotencyStore, type KeyLease } from './idempotency.store';
import { asJson } from './storage-policy';

const CLS_KEY = 'durby:idempotency';

/** The current request's key, set by the interceptor for @Idempotent routes. */
export interface RequestLease {
  lease: KeyLease;
  /** The route's success status (its @HttpCode, or 201 for POST and 200 otherwise). */
  successStatus: number;
  completion: 'response' | 'transaction';
  /** Set by completeInTransaction: the body stored with the business change. */
  storedBody?: unknown;
}

/**
 * Public API for services (docs/platform/idempotency.md → Transaction completion). Writes that are
 * not naturally idempotent store their result inside their own business transaction, so a crash
 * after commit can't lead to a second write (ADR 0014 §6, CLAUDE.md rule 8).
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly cls: ClsService,
    private readonly store: IdempotencyStore,
  ) {}

  /**
   * Stores `body` as the request's result in `tx`, right before the caller commits. Throws 409
   * `idempotency.request_in_progress` when a retry took the key over meanwhile, which rolls the
   * caller's transaction back. Outside an @Idempotent({ completion: 'transaction' }) request
   * (jobs, scripts, tests) it does nothing.
   */
  async completeInTransaction(tx: TenantTransactionClient, body: unknown): Promise<void> {
    const current = this.current();
    if (!current || current.completion !== 'transaction') return;
    const json = asJson(body);
    const stored = await this.store.completeIn(tx, current.lease, current.successStatus, json);
    if (!stored) throw idempotencyErrors.requestInProgress();
    current.storedBody = json;
  }

  /** @internal Used by the interceptor. */
  begin(lease: RequestLease): void {
    this.cls.set(CLS_KEY, lease);
  }

  /** @internal Used by the interceptor. */
  current(): RequestLease | undefined {
    return this.cls.isActive() ? this.cls.get<RequestLease | undefined>(CLS_KEY) : undefined;
  }
}
