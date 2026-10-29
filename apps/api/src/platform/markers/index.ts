// Route markers (CLAUDE.md rules 8 and 10): plain metadata decorators and their keys. A leaf
// folder: it imports nothing from platform, so every controller can use it without an import cycle
// (docs/reviews/phase-1.md → R2). The guards and boot checks in auth, rbac, entitlements and
// idempotency read these keys.
export { Authenticated, IS_AUTHENTICATED_KEY } from './authenticated.decorator';
export {
  IDEMPOTENCY_EXEMPT_KEY,
  IdempotencyExempt,
  Idempotent,
  IDEMPOTENT_KEY,
  type IdempotentOptions,
} from './idempotent.decorator';
export {
  IS_PLATFORM_ONLY_KEY,
  PlatformOnly,
  type PlatformOnlyMetadata,
  type PlatformOnlyOptions,
} from './platform-only.decorator';
export { IS_PUBLIC_KEY, Public } from './public.decorator';
export { featuresOf, REQUIRED_FEATURE_KEY, RequireFeature } from './require-feature.decorator';
export { REQUIRED_PERMISSION_KEY, RequirePermission } from './require-permission.decorator';
