import { healthResponseSchema, liveResponseSchema } from '@durby/shared';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config';
import type { PrismaService } from '../database';
import type { RedisService } from '../redis';
import { CHECK_TIMEOUT_MS, HealthService } from './health.service';

const config = { APP_VERSION: '1.2.3' } as AppConfig;

function makeService(deps: { db?: () => Promise<unknown>; redis?: () => Promise<unknown> }) {
  const prisma = { $queryRaw: vi.fn(deps.db ?? (() => Promise.resolve([{ '?column?': 1 }]))) };
  const redis = { ping: vi.fn(deps.redis ?? (() => Promise.resolve('PONG'))) };
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const service = new HealthService(
    config,
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    logger as unknown as PinoLogger,
  );
  return { service, logger };
}

describe('HealthService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports ok when database and Redis answer', async () => {
    const { service } = makeService({});
    const report = await service.readiness();
    expect(healthResponseSchema.parse(report)).toMatchObject({
      status: 'ok',
      version: '1.2.3',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('reports degraded with database down, without leaking the error', async () => {
    const { service, logger } = makeService({
      db: () => Promise.reject(new Error('password authentication failed for durby_app')),
    });
    const report = await service.readiness();
    expect(report).toMatchObject({ status: 'degraded', checks: { database: 'down', redis: 'up' } });
    expect(JSON.stringify(report)).not.toContain('password');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'database' }),
      'health check failed',
    );
  });

  it('reports degraded with Redis down', async () => {
    const { service } = makeService({ redis: () => Promise.reject(new Error('ECONNREFUSED')) });
    await expect(service.readiness()).resolves.toMatchObject({
      status: 'degraded',
      checks: { database: 'up', redis: 'down' },
    });
  });

  it('treats a hanging check as down after the timeout', async () => {
    vi.useFakeTimers();
    const { service } = makeService({ redis: () => new Promise(() => undefined) });
    const pending = service.readiness();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ checks: { redis: 'down' } });
  });

  it('answers liveness without touching dependencies', () => {
    const { service } = makeService({
      db: () => Promise.reject(new Error('down')),
      redis: () => Promise.reject(new Error('down')),
    });
    expect(liveResponseSchema.parse(service.live())).toMatchObject({
      status: 'ok',
      version: '1.2.3',
    });
  });
});
