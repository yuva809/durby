// Public API of platform/idempotency: route markers and transaction completion for services
// (docs/platform/idempotency.md). Storage and the interceptor are internal.
export { IdempotencyExempt, Idempotent, type IdempotentOptions } from './idempotent.decorator';
export {
  findIdempotencyMarkerProblems,
  type IdempotencyRouteInfo,
  listIdempotencyRoutes,
} from './idempotency-markers';
export { idempotencyErrors } from './idempotency-errors';
export { IdempotencyService } from './idempotency.service';
// The Nest module is exported last: platform folders depend on each other's services and
// decorators, so a partly loaded index (import cycle through a module) must already export them.
export { IdempotencyModule } from './idempotency.module';
