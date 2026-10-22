import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis';

export interface RateLimitRule {
  /** Key namespace, e.g. `auth.login.ip`. */
  name: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Hits in the current window, including this one. */
  count: number;
  /** Seconds until the window resets (≥ 1). */
  retryAfterSeconds: number;
}

/** Thrown when Redis is unreachable. Callers fail closed: no Redis, no rate-limited action. */
export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Rate limiter unavailable', { cause });
    this.name = 'RateLimiterUnavailableError';
  }
}

// INCR + PEXPIRE on the first hit of a window, atomically. Returns [count, pttl].
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

/** Fixed-window counters in Redis, shared by every api instance. */
@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /** Counts one hit for `key` under `rule`. `key` must not contain secrets (hash emails first). */
  async hit(rule: RateLimitRule, key: string): Promise<RateLimitResult> {
    let reply: unknown;
    try {
      reply = await this.redis.eval(HIT_SCRIPT, 1, `rl:${rule.name}:${key}`, rule.windowMs);
    } catch (error) {
      throw new RateLimiterUnavailableError(error);
    }
    const [count, ttlMs] = reply as [number, number];
    return {
      allowed: count <= rule.limit,
      count,
      retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }
}
