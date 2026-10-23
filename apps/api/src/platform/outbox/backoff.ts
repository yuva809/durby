/** Longest wait between dispatch attempts. */
export const MAX_DISPATCH_BACKOFF_MS = 600_000;

/**
 * Wait before the next dispatch attempt after `attempts` failures (ADR 0013 §4):
 * min(2^attempts s, 10 min), ±20 % jitter so tenants that failed together don't retry together.
 * `random` is in [0, 1).
 */
export function dispatchBackoffMs(attempts: number, random: number = Math.random()): number {
  const base = Math.min(2 ** attempts * 1000, MAX_DISPATCH_BACKOFF_MS);
  return Math.round(base * (0.8 + 0.4 * random));
}
