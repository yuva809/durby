import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import type { PoolSnapshot } from './pool-metrics';
import { PrismaService } from './prisma.service';

/** How often the pool is reported. */
export const POOL_REPORT_EVERY_MS = 30_000;

/**
 * The database pool as a log (ADR 0021), like `outbox.lag`: `db.pool` every 30 s with the pool's
 * state and the checkouts' waits; `warn` while requests queue for a connection or the longest wait
 * reached half of PRISMA_TX_MAX_WAIT_MS (the 503 platform.busy threshold).
 */
@Injectable()
export class PoolReporter implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private readonly logger = new Logger('database');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.report(), POOL_REPORT_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  report(): PoolSnapshot {
    const snapshot = this.prisma.poolSnapshot();
    const fields = { event: 'db.pool', ...snapshot };
    if (snapshot.waiting > 0 || snapshot.waitMsMax >= this.config.PRISMA_TX_MAX_WAIT_MS / 2) {
      this.logger.warn(fields, 'db.pool');
    } else {
      this.logger.log(fields, 'db.pool');
    }
    return snapshot;
  }
}
