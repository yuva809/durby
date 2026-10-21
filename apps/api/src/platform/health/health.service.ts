import { Inject, Injectable } from '@nestjs/common';
import type { DependencyStatus, HealthResponse, LiveResponse } from '@durby/shared';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../database';
import { RedisService } from '../redis';

/** A check slower than this counts as down: health must answer quickly even when a dependency hangs. */
export const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthService.name);
  }

  live(): LiveResponse {
    return { status: 'ok', version: this.config.APP_VERSION, time: new Date().toISOString() };
  }

  async readiness(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      this.check('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.check('redis', () => this.redis.ping()),
    ]);
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      version: this.config.APP_VERSION,
      time: new Date().toISOString(),
      checks: { database, redis },
    };
  }

  private async check(name: string, probe: () => Promise<unknown>): Promise<DependencyStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)),
        CHECK_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([probe(), timeout]);
      return 'up';
    } catch (err) {
      // Details stay in the server log; the response only says up/down.
      this.logger.warn({ check: name, err }, 'health check failed');
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
