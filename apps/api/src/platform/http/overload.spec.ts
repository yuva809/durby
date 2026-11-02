import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { knownErrorResponse } from './api-exception.filter';
import { overloadKind } from './overload';

/** ADR 0021: database overload is a retryable 503, everything else keeps its answer. */
describe('overloadKind', () => {
  it('recognises pool/transaction timeouts, lock timeouts and deadlocks', () => {
    expect(
      overloadKind({ code: 'P2028', message: 'Unable to start a transaction in the given time.' }),
    ).toBe('pool_or_transaction_timeout');
    expect(overloadKind({ code: 'P2028', meta: { timeout: 5000, timeTaken: 5120 } })).toBe(
      'pool_or_transaction_timeout',
    );
    expect(overloadKind({ code: 'P2010', meta: { code: '55P03' } })).toBe('lock_timeout');
    expect(overloadKind(new Error('canceling statement due to lock timeout'))).toBe('lock_timeout');
    expect(
      overloadKind({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
      }),
    ).toBe('deadlock');
  });

  it('leaves other errors alone', () => {
    for (const error of [
      new Error('boom'),
      { code: 'P2002' },
      { code: 'P2010', meta: { code: '23P01' } },
      null,
      'x',
    ]) {
      expect(overloadKind(error)).toBeNull();
    }
  });
});

describe('knownErrorResponse for overload', () => {
  it('answers 503 platform.busy with Retry-After, without the driver message', () => {
    const response = knownErrorResponse({ code: 'P2028', message: 'secret query values' });
    expect(response).toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { code: 'platform.busy', message: 'The service is busy. Retry shortly.' },
      headers: { 'Retry-After': '2' },
    });
  });
});
