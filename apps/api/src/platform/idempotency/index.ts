// Public API of platform/idempotency: route markers and transaction completion for services
// (docs/platform/idempotency.md). Storage and the interceptor are internal.
export { IdempotencyExempt, Idempotent, type IdempotentOptions } from '../markers';
export {
  findIdempotencyMarkerProblems,
  type IdempotencyRouteInfo,
  listIdempotencyRoutes,
} from './idempotency-markers';
export { idempotencyErrors } from './idempotency-errors';
export { IdempotencyService } from './idempotency.service';
export { IdempotencyModule } from './idempotency.module';
