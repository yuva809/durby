import { describe, expect, it } from 'vitest';
import { dispatchBackoffMs, MAX_DISPATCH_BACKOFF_MS } from './backoff';

describe('dispatchBackoffMs', () => {
  it('doubles per attempt from 2 s', () => {
    expect([1, 2, 3, 4].map((n) => dispatchBackoffMs(n, 0.5))).toEqual([2000, 4000, 8000, 16000]);
  });

  it('caps at 10 minutes', () => {
    expect(dispatchBackoffMs(20, 0.5)).toBe(MAX_DISPATCH_BACKOFF_MS);
  });

  it('jitters by ±20 %', () => {
    expect(dispatchBackoffMs(3, 0)).toBe(6400);
    expect(dispatchBackoffMs(3, 0.999999)).toBe(9600);
  });
});
