import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from '../src/platform/auth/clock';
import { LockoutService } from '../src/platform/auth/lockout.service';
import { ConfigModule } from '../src/platform/config';
import { RedisModule, RedisService } from '../src/platform/redis';
import { FakeClock } from './support/fake-clock';

const MIN = 60_000;

describe('LockoutService (Redis)', () => {
  let moduleRef: TestingModule;
  let lockout: LockoutService;
  let redis: RedisService;
  const clock = new FakeClock();
  let key: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule],
      providers: [LockoutService, { provide: Clock, useValue: clock }],
    }).compile();
    await moduleRef.init();
    lockout = moduleRef.get(LockoutService);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    key = uuidv7();
  });

  const fail = async (times: number) => {
    let state = { locked: false, retryAfterSeconds: 0 };
    for (let i = 0; i < times; i++) state = await lockout.recordFailure(key);
    return state;
  };

  it('locks for 1 minute after 5 consecutive failures', async () => {
    expect(await fail(4)).toEqual({ locked: false, retryAfterSeconds: 0 });
    expect(await lockout.check(key)).toEqual({ locked: false, retryAfterSeconds: 0 });
    expect(await fail(1)).toEqual({ locked: true, retryAfterSeconds: 60 });
    expect(await lockout.check(key)).toEqual({ locked: true, retryAfterSeconds: 60 });
  });

  it('neither counts nor extends failures while locked', async () => {
    await fail(5);
    clock.advance(30_000);
    expect(await fail(10)).toEqual({ locked: true, retryAfterSeconds: 30 });
    clock.advance(30_000);
    expect(await lockout.check(key)).toEqual({ locked: false, retryAfterSeconds: 0 });
    // Next failure is the 6th, not the 16th: 2 minutes.
    expect(await fail(1)).toEqual({ locked: true, retryAfterSeconds: 120 });
  });

  it('doubles per further failure and caps at 15 minutes', async () => {
    await fail(5);
    const durations: number[] = [];
    for (let i = 0; i < 6; i++) {
      clock.advance(16 * MIN);
      durations.push((await fail(1)).retryAfterSeconds);
    }
    expect(durations).toEqual([120, 240, 480, 900, 900, 900]);
  });

  it('is temporary: the lock always runs out', async () => {
    await fail(20);
    clock.advance(15 * MIN);
    expect((await lockout.check(key)).locked).toBe(false);
  });

  it('reset clears failures and lock', async () => {
    await fail(5);
    await lockout.reset(key);
    expect(await lockout.check(key)).toEqual({ locked: false, retryAfterSeconds: 0 });
    expect(await fail(4)).toEqual({ locked: false, retryAfterSeconds: 0 });
  });

  it('forgets failures 24 hours after the last one', async () => {
    await fail(3);
    const ttl = await redis.pttl(`auth:lock:${key}`);
    expect(ttl).toBeGreaterThan(24 * 60 * MIN - 5_000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * MIN);
  });

  it('keeps accounts apart', async () => {
    await fail(5);
    expect((await lockout.check(uuidv7())).locked).toBe(false);
  });
});
