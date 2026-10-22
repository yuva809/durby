import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis';
import { Clock } from './clock';

/** Consecutive failures before the first lock. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_BASE_MS = 60_000;
export const LOCKOUT_MAX_MS = 15 * 60_000;
/** The failure count is forgotten this long after the last failure. */
export const LOCKOUT_MEMORY_MS = 24 * 60 * 60_000;

/** 0 below the threshold; then 1 min, doubling per further failure, capped at 15 min. */
export function lockDurationMs(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0;
  return Math.min(LOCKOUT_BASE_MS * 2 ** (failures - LOCKOUT_THRESHOLD), LOCKOUT_MAX_MS);
}

export interface LockState {
  locked: boolean;
  retryAfterSeconds: number;
}

export class LockoutUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Lockout store unavailable', { cause });
    this.name = 'LockoutUnavailableError';
  }
}

// KEYS[1] = state hash, ARGV = now ms, memory ms, threshold, base ms, max ms.
// While locked, a failure is neither counted nor extends the lock.
const RECORD_FAILURE = `
local now = tonumber(ARGV[1])
local locked_until = tonumber(redis.call('HGET', KEYS[1], 'locked_until') or '0')
if locked_until > now then return {1, locked_until - now} end
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
local threshold = tonumber(ARGV[3])
if failures < threshold then return {0, 0} end
local duration = math.min(tonumber(ARGV[4]) * 2 ^ (failures - threshold), tonumber(ARGV[5]))
redis.call('HSET', KEYS[1], 'locked_until', now + duration)
return {1, duration}
`;

/**
 * Temporary account lockout with exponential backoff (ADR 0006), keyed on the email hash so
 * unknown emails behave exactly like real ones. Never permanent: locks are capped, and a successful
 * login or password reset clears the state.
 */
@Injectable()
export class LockoutService {
  constructor(
    private readonly redis: RedisService,
    private readonly clock: Clock,
  ) {}

  async check(emailKey: string): Promise<LockState> {
    const lockedUntil = Number(
      (await this.call(() => this.redis.hget(key(emailKey), 'locked_until'))) ?? 0,
    );
    const remaining = lockedUntil - this.clock.now().getTime();
    return remaining > 0
      ? { locked: true, retryAfterSeconds: Math.ceil(remaining / 1000) }
      : { locked: false, retryAfterSeconds: 0 };
  }

  /** Records a failed attempt; returns the lock it caused (or the one already in place). */
  async recordFailure(emailKey: string): Promise<LockState> {
    const reply = await this.call(() =>
      this.redis.eval(
        RECORD_FAILURE,
        1,
        key(emailKey),
        this.clock.now().getTime(),
        LOCKOUT_MEMORY_MS,
        LOCKOUT_THRESHOLD,
        LOCKOUT_BASE_MS,
        LOCKOUT_MAX_MS,
      ),
    );
    const [locked, remainingMs] = reply as [number, number];
    return locked === 1
      ? { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) }
      : { locked: false, retryAfterSeconds: 0 };
  }

  async reset(emailKey: string): Promise<void> {
    await this.call(() => this.redis.del(key(emailKey)));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new LockoutUnavailableError(error);
    }
  }
}

const key = (emailKey: string): string => `auth:lock:${emailKey}`;
