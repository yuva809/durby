import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { OutboxCleanup } from './cleanup';
import { OutboxDispatcher } from './dispatcher';
import { OutboxEventRunner } from './event-runner';
import { OutboxHandlerRegistry } from './handler-registry';
import { OutboxLagReporter } from './lag-reporter';
import { OutboxAdmin } from './outbox-admin';
import { OutboxPublisher } from './outbox-queue';
import { OutboxWorker } from './outbox-worker';
import { OutboxService } from './outbox.service';
import { OutboxWakeup } from './wakeup';

/**
 * Outbox (docs/platform/outbox.md). The api process only writes events (OutboxService) and checks
 * the declared handlers at boot; the worker process (src/worker.ts) starts OutboxWorker. BullMQ
 * connects lazily, so the api opens no BullMQ connection. Depends on tenancy, config and audit.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    OutboxService,
    OutboxHandlerRegistry,
    OutboxPublisher,
    OutboxDispatcher,
    OutboxEventRunner,
    OutboxCleanup,
    OutboxLagReporter,
    OutboxWorker,
    OutboxWakeup,
    OutboxAdmin,
  ],
  exports: [
    OutboxService,
    OutboxDispatcher,
    OutboxEventRunner,
    OutboxCleanup,
    OutboxLagReporter,
    OutboxWorker,
    OutboxAdmin,
    OutboxPublisher,
    OutboxWakeup,
  ],
})
export class OutboxModule {}
