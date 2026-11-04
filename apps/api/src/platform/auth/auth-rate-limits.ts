import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { RateLimiter, RateLimiterUnavailableError, type RateLimitRule } from '../rate-limit';
import { authErrors } from './auth-errors';

const MIN = 60_000;

/**
 * docs/platform/auth.md → Abuse protection. Email keys are hashes (crypto.emailKey). The counts
 * come from the `RATE_LIMIT_*` env vars (ADR 0015 §14), the windows are fixed here.
 */
export function authRateLimits(config: AppConfig) {
  return {
    loginIp: { name: 'auth.login.ip', limit: config.RATE_LIMIT_LOGIN_IP, windowMs: 5 * MIN },
    loginEmail: {
      name: 'auth.login.email',
      limit: config.RATE_LIMIT_LOGIN_EMAIL,
      windowMs: 15 * MIN,
    },
    refreshIp: { name: 'auth.refresh.ip', limit: config.RATE_LIMIT_REFRESH_IP, windowMs: MIN },
    mailIp: { name: 'auth.mail.ip', limit: config.RATE_LIMIT_MAIL_IP, windowMs: 15 * MIN },
    mailEmail: { name: 'auth.mail.email', limit: config.RATE_LIMIT_MAIL_EMAIL, windowMs: 60 * MIN },
    tokenIp: { name: 'auth.token.ip', limit: config.RATE_LIMIT_TOKEN_IP, windowMs: 15 * MIN },
    /** Invitation preview and accept: like the reset/verify endpoints (docs/platform/rbac.md). */
    invitationTokenIp: {
      name: 'rbac.invitation.token.ip',
      limit: config.RATE_LIMIT_TOKEN_IP,
      windowMs: 15 * MIN,
    },
    /**
     * The public table menu (ADR 0026): guests of one restaurant often share its Wi-Fi address, so
     * five times the refresh count per minute.
     */
    publicMenuIp: {
      name: 'pos.menu.ip',
      limit: config.RATE_LIMIT_REFRESH_IP * 5,
      windowMs: MIN,
    },
    /** Adding staff (accounts with temporary passwords, invitations) per organization (ADR 0023). */
    teamCreateOrg: {
      name: 'rbac.team.create.org',
      limit: config.RATE_LIMIT_LOGIN_IP,
      windowMs: 15 * MIN,
    },
  } as const satisfies Record<string, RateLimitRule>;
}

export type AuthRateLimitRules = ReturnType<typeof authRateLimits>;

@Injectable()
export class AuthRateLimits {
  readonly rules: AuthRateLimitRules;

  constructor(
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.rules = authRateLimits(config);
  }

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
