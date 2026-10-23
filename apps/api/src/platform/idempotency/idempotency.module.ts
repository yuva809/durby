import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { OutboxCleanup } from '../outbox';
import { IdempotencyMarkerCheck } from './idempotency-marker.check';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyStore } from './idempotency.store';

/**
 * Idempotency keys (docs/platform/idempotency.md). The interceptor acts only on @Idempotent()
 * routes; expired keys are deleted by the worker's hourly retention pass. Depends on tenancy, http,
 * rbac (route markers) and outbox (retention).
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    IdempotencyStore,
    IdempotencyService,
    IdempotencyMarkerCheck,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule implements OnModuleInit {
  constructor(
    private readonly cleanup: OutboxCleanup,
    private readonly store: IdempotencyStore,
  ) {}

  onModuleInit(): void {
    this.cleanup.register({
      name: 'idempotencyKeys',
      run: (tx) => this.store.deleteExpiredOfCurrentTenant(tx),
    });
  }
}
