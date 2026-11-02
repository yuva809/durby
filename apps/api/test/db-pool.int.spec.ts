import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PoolReporter, PrismaService } from '../src/platform/database';

/**
 * ADR 0021: pool size and Prisma's transaction limits come from the env; the pool reports its
 * state and checkout waits (db.pool). Booted with a pool of 3 and a 300 ms maxWait.
 */
describe('database pool settings and metrics', () => {
  let app: INestApplication;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_POOL_SIZE = '3';
    process.env.PRISMA_TX_MAX_WAIT_MS = '300';
    process.env.PRISMA_TX_TIMEOUT_MS = '10000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = saved;
  });

  it('uses the configured pool size and maxWait, and reports waits and queueing', async () => {
    const prisma = app.get(PrismaService);
    prisma.poolSnapshot(); // start a fresh window
    const sleep = () => prisma.$transaction((tx) => tx.$executeRaw`SELECT pg_sleep(1)`);
    const sleepers = [sleep(), sleep(), sleep()];
    await new Promise((r) => setTimeout(r, 150));

    // All 3 connections busy: another transaction gives up after 300 ms (P2028 → 503 busy).
    const started = performance.now();
    await expect(prisma.$transaction((tx) => tx.$executeRaw`SELECT 1`)).rejects.toMatchObject({
      code: 'P2028',
    });
    expect(performance.now() - started).toBeLessThan(2000);

    const warn = vi.spyOn(Logger.prototype, 'warn');
    // Waits in the pool's queue for a sleeper (its own longer maxWait, to be observed waiting).
    const queued = prisma.$transaction((tx) => tx.$executeRaw`SELECT 1`, { maxWait: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    const busy = app.get(PoolReporter).report();
    expect(busy).toMatchObject({ size: 3, total: 3, idle: 0 });
    expect(busy.waiting).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'db.pool' }), 'db.pool');

    await Promise.all([...sleepers, queued]);
    const after = app.get(PoolReporter).report();
    expect(after.checkouts).toBeGreaterThanOrEqual(1);
    expect(after.waitMsMax).toBeGreaterThan(500); // the queued one waited for a sleeper
    expect(after.total).toBeLessThanOrEqual(3);
  }, 30_000);
});
