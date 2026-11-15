import { Injectable } from '@nestjs/common';
import { REALTIME_MAX_IDS, type RealtimeChanged, type RealtimeTopic } from '@durby/shared';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../redis';
import { TenantContext } from '../tenancy';
import { realtimeChannel } from './sse';

/**
 * Publishes "something changed here" hints for open streams (ADR 0044 §3). Called by a module's
 * outbox handler, so only for committed changes; the tenant is the handler's tenant context. Fire and
 * forget: a Redis error is logged and never fails the handler, since pages catch up by polling.
 */
@Injectable()
export class RealtimePublisher {
  constructor(
    private readonly redis: RedisService,
    private readonly tenantContext: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('realtime');
  }

  async publish(locationId: string, topic: RealtimeTopic, ids: readonly string[]): Promise<void> {
    const { tenantId } = this.tenantContext.require();
    const channel = realtimeChannel(tenantId, locationId, topic);
    const unique = [...new Set(ids)];
    try {
      for (let i = 0; i === 0 || i < unique.length; i += REALTIME_MAX_IDS) {
        const message: RealtimeChanged = { topic, ids: unique.slice(i, i + REALTIME_MAX_IDS) };
        await this.redis.publish(channel, JSON.stringify(message));
      }
    } catch (error) {
      this.logger.warn(
        { event: 'realtime.publish_failed', topic, error: (error as Error).message },
        'realtime.publish_failed',
      );
    }
  }
}
