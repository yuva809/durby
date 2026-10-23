import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Outbox (docs/platform/outbox.md). The api process only writes events; publishing and handlers
 * run in the worker process (src/worker.ts). Depends only on tenancy, so every writer can use it.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
