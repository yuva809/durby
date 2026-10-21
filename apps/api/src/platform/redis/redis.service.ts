import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config';

/**
 * Shared Redis connection for caching and health checks. BullMQ (later) opens its own
 * connections, since workers need blocking commands and `maxRetriesPerRequest: null`.
 */
@Injectable()
export class RedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super(config.REDIS_URL, {
      lazyConnect: true,
      // Fail fast while disconnected instead of queueing, so health checks report "down".
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
    });
  }

  /** Connect eagerly so a bad REDIS_URL fails the boot, not the first request. */
  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
