import { describe, expect, it } from 'vitest';
import { isBusy } from './busy';

/** Overload errors become 503 reservations.busy; everything else stays as it is. */
describe('isBusy', () => {
  it('recognises pool and transaction timeouts (P2028) and lock timeouts (55P03)', () => {
    expect(
      isBusy({ code: 'P2028', message: 'Unable to start a transaction in the given time.' }),
    ).toBe(true);
    expect(isBusy({ code: 'P2028', meta: { timeout: 5000, timeTaken: 5056 } })).toBe(true);
    expect(
      isBusy({
        code: 'P2010',
        meta: { code: '55P03', message: 'canceling statement due to lock timeout' },
      }),
    ).toBe(true);
    expect(isBusy(new Error('canceling statement due to lock timeout'))).toBe(true);
    expect(
      isBusy({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
        message: 'deadlock detected',
      }),
    ).toBe(true);
  });

  it('leaves other errors alone', () => {
    for (const error of [
      new Error('boom'),
      { code: 'P2002' },
      { code: 'P2010', meta: { code: '23P01' } },
      null,
      undefined,
    ]) {
      expect(isBusy(error)).toBe(false);
    }
  });
});
