import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaClient } from './generated/client';
import { type PoolSnapshot, PoolWaits } from './pool-metrics';

/**
 * Raw Prisma client connected as durby_app (DATABASE_URL, no BYPASSRLS).
 * Step 1.1 wraps it in the tenant-scoped client; business code uses that, not this.
 * Owns its pg pool (DATABASE_POOL_SIZE) and measures how long checkouts wait (ADR 0021).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly pool: pg.Pool;
  private readonly waits: PoolWaits;
  private readonly size: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_SIZE,
    });
    const waits = new PoolWaits();
    // Time from asking for a connection to getting one: the wait PRISMA_TX_MAX_WAIT_MS bounds. Both
    // forms: promise (the adapter's transactions) and callback (pg's own pool.query).
    const connect = pool.connect.bind(pool) as (
      callback?: (error: Error | undefined, client: pg.PoolClient, done: () => void) => void,
    ) => Promise<pg.PoolClient> | undefined;
    pool.connect = ((
      callback?: (error: Error | undefined, client: pg.PoolClient, done: () => void) => void,
    ) => {
      const started = performance.now();
      if (callback) {
        return connect((error, client, done) => {
          if (!error) waits.record(performance.now() - started);
          callback(error, client, done);
        });
      }
      return connect()!.then((client) => {
        waits.record(performance.now() - started);
        return client;
      });
    }) as typeof pool.connect;
    super({
      adapter: new PrismaPg(pool),
      transactionOptions: {
        maxWait: config.PRISMA_TX_MAX_WAIT_MS,
        timeout: config.PRISMA_TX_TIMEOUT_MS,
      },
    });
    this.pool = pool;
    this.waits = waits;
    this.size = config.DATABASE_POOL_SIZE;
  }

  /** Connect eagerly so a bad DATABASE_URL fails the boot, not the first request. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    if (!this.pool.ended) await this.pool.end();
  }

  /** The pool now and its checkouts since the last call (the db.pool log). */
  poolSnapshot(): PoolSnapshot {
    return {
      size: this.size,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      ...this.waits.take(),
    };
  }
}
