import { Global, Module } from '@nestjs/common';
import { RealtimeHub } from './realtime-hub';
import { RealtimePublisher } from './realtime-publisher';
import { RealtimeStreams } from './realtime-streams';

/**
 * Live updates (docs/platform/realtime.md, ADR 0044). Modules publish hints from their outbox
 * handlers (RealtimePublisher) and serve their stream route with RealtimeStreams. Depends on config,
 * auth, tenancy and Redis; never on modules.
 */
@Global()
@Module({
  providers: [RealtimeHub, RealtimePublisher, RealtimeStreams],
  exports: [RealtimeHub, RealtimePublisher, RealtimeStreams],
})
export class RealtimeModule {}
