import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule, loadConfig } from '../src/platform/config';
import {
  RateLimiter,
  RateLimiterUnavailableError,
  RateLimitModule,
} from '../src/platform/rate-limit';
import { RedisModule, RedisService } from '../src/platform/redis';

describe('RateLimiter (Redis)', () => {
  let moduleRef: TestingModule;
  let limiter: RateLimiter;
  let redis: RedisService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule, RateLimitModule],
    }).compile();
    await moduleRef.init();
    limiter = moduleRef.get(RateLimiter);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const rule = (limit: number, windowMs = 60_000) => ({
    name: `test.${uuidv7()}`,
    limit,
    windowMs,
  });

  it('allows up to the limit, then rejects with a Retry-After', async () => {
    const r = rule(3);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.hit(r, 'k'));
    expect(results.map((x) => x.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ count: 4 });
    expect(results[3]?.retryAfterSeconds).toBeGreaterThan(55);
    expect(results[3]?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts keys and rules separately', async () => {
    const r = rule(1);
    expect((await limiter.hit(r, 'a')).allowed).toBe(true);
    expect((await limiter.hit(r, 'b')).allowed).toBe(true);
    expect((await limiter.hit(rule(1), 'a')).allowed).toBe(true);
    expect((await limiter.hit(r, 'a')).allowed).toBe(false);
  });

  it('starts a new window after it expires', async () => {
    const r = rule(1, 200);
    expect((await limiter.hit(r, 'k')).allowed).toBe(true);
    expect((await limiter.hit(r, 'k')).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await limiter.hit(r, 'k')).allowed).toBe(true);
  });

  it('is atomic under concurrent hits', async () => {
    const r = rule(10);
    const results = await Promise.all(Array.from({ length: 25 }, () => limiter.hit(r, 'k')));
    expect(results.filter((x) => x.allowed)).toHaveLength(10);
    expect(await redis.pttl(`rl:${r.name}:k`)).toBeGreaterThan(0);
  });

  it('fails closed when Redis is unreachable', async () => {
    // Never connected; the offline queue is disabled, so commands fail at once.
    const offline = new RedisService(loadConfig());
    await expect(new RateLimiter(offline).hit(rule(5), 'k')).rejects.toThrow(
      RateLimiterUnavailableError,
    );
    offline.disconnect();
  });
});
