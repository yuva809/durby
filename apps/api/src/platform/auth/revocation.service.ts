import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { RedisService } from '../redis';
import type { AccessTokenClaims } from './access-token.service';

export class RevocationUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Revocation store unavailable', { cause });
    this.name = 'RevocationUnavailableError';
  }
}

/** Covers the guard's clock tolerance on top of the access token lifetime. */
const TTL_SLACK_SECONDS = 30;

/**
 * Ends access tokens before their `exp` (ADR 0006): per session on logout and reuse detection,
 * per user on password reset. Markers live as long as an access token can, then expire.
 */
@Injectable()
export class RevocationService {
  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get ttlSeconds(): number {
    return this.config.JWT_ACCESS_TTL_SECONDS + TTL_SLACK_SECONDS;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.call(() => this.redis.set(sessionKey(sessionId), '1', 'EX', this.ttlSeconds));
  }

  /**
   * Rejects the user's access tokens issued before `at`. `iat` has second resolution, so a token from
   * the same second survives: that keeps a login right after a reset working, and such a token
   * cannot be refreshed (the reset revokes all refresh families).
   */
  async revokeUser(userId: string, at: Date): Promise<void> {
    const seconds = String(Math.floor(at.getTime() / 1000));
    await this.call(() => this.redis.set(userKey(userId), seconds, 'EX', this.ttlSeconds));
  }

  async isRevoked(claims: AccessTokenClaims): Promise<boolean> {
    const [session, userRevokedAt] = await this.call(() =>
      this.redis.mget(sessionKey(claims.sessionId), userKey(claims.userId)),
    );
    if (session !== null && session !== undefined) return true;
    return (
      userRevokedAt !== null &&
      userRevokedAt !== undefined &&
      claims.issuedAt < Number(userRevokedAt)
    );
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new RevocationUnavailableError(error);
    }
  }
}

const sessionKey = (sessionId: string): string => `auth:revoked:sid:${sessionId}`;
const userKey = (userId: string): string => `auth:revoked:user:${userId}`;
