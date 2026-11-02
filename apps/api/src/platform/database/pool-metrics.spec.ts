import { describe, expect, it } from 'vitest';
import { PoolWaits } from './pool-metrics';

describe('PoolWaits', () => {
  it('reports count, average and longest wait, then starts a new window', () => {
    const waits = new PoolWaits();
    expect(waits.take()).toEqual({ checkouts: 0, waitMsAvg: 0, waitMsMax: 0 });
    for (const ms of [0.4, 10.2, 1250.6]) waits.record(ms);
    expect(waits.take()).toEqual({ checkouts: 3, waitMsAvg: 420, waitMsMax: 1251 });
    expect(waits.take()).toEqual({ checkouts: 0, waitMsAvg: 0, waitMsMax: 0 });
  });
});
