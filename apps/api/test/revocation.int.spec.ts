import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessTokenClaims } from '../src/platform/auth/access-token.service';
import { RevocationService } from '../src/platform/auth/revocation.service';
import { ConfigModule } from '../src/platform/config';
import { RedisModule, RedisService } from '../src/platform/redis';

describe('RevocationService (Redis)', () => {
  let moduleRef: TestingModule;
  let revocations: RevocationService;
  let redis: RedisService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule],
      providers: [RevocationService],
    }).compile();
    await moduleRef.init();
    revocations = moduleRef.get(RevocationService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const claims = (issuedAt: number, over: Partial<AccessTokenClaims> = {}): AccessTokenClaims => ({
    userId: uuidv7(),
    organizationId: null,
    sessionId: uuidv7(),
    issuedAt,
    expiresAt: issuedAt + 600,
    ...over,
  });

  it('a revoked session rejects its tokens only', async () => {
    const mine = claims(1000);
    await revocations.revokeSession(mine.sessionId);
    expect(await revocations.isRevoked(mine)).toBe(true);
    expect(await revocations.isRevoked(claims(1000, { userId: mine.userId }))).toBe(false);
  });

  it('a revoked user rejects tokens issued before the revocation second', async () => {
    const userId = uuidv7();
    await revocations.revokeUser(userId, new Date(2_000_500));
    expect(await revocations.isRevoked(claims(1999, { userId }))).toBe(true);
    // Same second as the reset: a fresh login right after it keeps working.
    expect(await revocations.isRevoked(claims(2000, { userId }))).toBe(false);
    expect(await revocations.isRevoked(claims(2001, { userId }))).toBe(false);
  });

  it('markers expire once no access token can still be valid', async () => {
    const sessionId = uuidv7();
    await revocations.revokeSession(sessionId);
    const ttl = await redis.ttl(`auth:revoked:sid:${sessionId}`);
    // JWT_ACCESS_TTL_SECONDS (default 600) + 30 s slack.
    expect(ttl).toBeGreaterThan(600);
    expect(ttl).toBeLessThanOrEqual(630);
  });
});
