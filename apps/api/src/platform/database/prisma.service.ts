import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaClient } from './generated/client';

/**
 * Raw Prisma client connected as durby_app (DATABASE_URL, no BYPASSRLS).
 * Step 1.1 wraps it in the tenant-scoped client; business code uses that, not this.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  /** Connect eagerly so a bad DATABASE_URL fails the boot, not the first request. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
