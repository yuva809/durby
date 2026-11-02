/**
 * What the database pool did since the last report (ADR 0021): how many checkouts, how long they
 * waited for a connection, and the pool's state now. Reported as the `db.pool` log.
 */
export interface PoolSnapshot {
  size: number;
  /** Connections open, idle in the pool, and requests waiting for one, right now. */
  total: number;
  idle: number;
  waiting: number;
  /** Checkouts since the last report and their wait for a connection. */
  checkouts: number;
  waitMsAvg: number;
  waitMsMax: number;
}

/** Collects checkout waits between two reports. */
export class PoolWaits {
  private count = 0;
  private sum = 0;
  private max = 0;

  record(ms: number): void {
    this.count++;
    this.sum += ms;
    this.max = Math.max(this.max, ms);
  }

  /** The window's numbers, and a fresh window. */
  take(): Pick<PoolSnapshot, 'checkouts' | 'waitMsAvg' | 'waitMsMax'> {
    const window = {
      checkouts: this.count,
      waitMsAvg: this.count === 0 ? 0 : Math.round(this.sum / this.count),
      waitMsMax: Math.round(this.max),
    };
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    return window;
  }
}
