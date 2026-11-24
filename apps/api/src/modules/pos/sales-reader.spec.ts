import { describe, expect, it } from 'vitest';
import { roundsOf } from './sales-reader';

describe('roundsOf (ADR 0081)', () => {
  const at = (seconds: number, sendId: string | null = null) => ({
    sendId,
    createdAt: new Date(Date.UTC(2026, 10, 24, 18, 0, 0) + seconds * 1000),
  });

  it('counts each send once, whatever its tickets', () => {
    expect(roundsOf([])).toBe(0);
    expect(roundsOf([at(0, 'a'), at(0, 'a'), at(1, 'b')])).toBe(2);
  });

  it('takes tickets without a send within two seconds as one send', () => {
    expect(roundsOf([at(0), at(1.9)])).toBe(1);
    expect(roundsOf([at(0), at(2.1)])).toBe(2);
    expect(roundsOf([at(0), at(1.5), at(3)])).toBe(2);
    expect(roundsOf([at(0), at(60, 'a'), at(60, 'a')])).toBe(2);
  });
});
