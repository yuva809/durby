import { describe, expect, it } from 'vitest';
import { lockDurationMs } from './lockout.service';

describe('lockDurationMs', () => {
  it('does not lock below 5 failures', () => {
    expect([0, 1, 2, 3, 4].map(lockDurationMs)).toEqual([0, 0, 0, 0, 0]);
  });

  it('locks for 1 min at 5 failures and doubles per further failure', () => {
    expect([5, 6, 7, 8].map(lockDurationMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
  });

  it('caps the lock at 15 minutes', () => {
    expect(lockDurationMs(9)).toBe(900_000);
    expect(lockDurationMs(50)).toBe(900_000);
  });
});
