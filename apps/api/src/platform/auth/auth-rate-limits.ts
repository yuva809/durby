import { Injectable } from '@nestjs/common';
import { RateLimiter, RateLimiterUnavailableError, type RateLimitRule } from '../rate-limit';
import { authErrors } from './auth-errors';

const MIN = 60_000;

/** docs/platform/auth.md → Abuse protection. Email keys are hashes (crypto.emailKey). */
export const AUTH_RATE_LIMITS = {
  loginIp: { name: 'auth.login.ip', limit: 20, windowMs: 5 * MIN },
  loginEmail: { name: 'auth.login.email', limit: 10, windowMs: 15 * MIN },
  refreshIp: { name: 'auth.refresh.ip', limit: 60, windowMs: MIN },
  mailIp: { name: 'auth.mail.ip', limit: 5, windowMs: 15 * MIN },
  mailEmail: { name: 'auth.mail.email', limit: 3, windowMs: 60 * MIN },
  tokenIp: { name: 'auth.token.ip', limit: 10, windowMs: 15 * MIN },
} as const satisfies Record<string, RateLimitRule>;

@Injectable()
export class AuthRateLimits {
  constructor(private readonly limiter: RateLimiter) {}

  /** Counts a hit against every rule; 429 auth.rate_limited if any is over, 503 if Redis is down. */
  async enforce(...hits: [RateLimitRule, string][]): Promise<void> {
    for (const [rule, key] of hits) {
      let result;
      try {
        result = await this.limiter.hit(rule, key);
      } catch (error) {
        if (error instanceof RateLimiterUnavailableError) throw authErrors.unavailable();
        throw error;
      }
      if (!result.allowed) throw authErrors.rateLimited(result.retryAfterSeconds);
    }
  }
}
