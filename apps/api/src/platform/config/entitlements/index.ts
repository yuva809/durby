// Public API of platform/config/entitlements: the check (services, guard, jobs) and the
// @RequireFeature decorator. EntitlementsAdmin is for the entitlements CLI and provisioning only.
export { ACTIVE_ENTITLEMENTS_LOOKUP, type ActiveEntitlementsLookup } from './active-entitlements';
export { EntitlementService } from './entitlement.service';
export {
  type Changed,
  EntitlementsAdmin,
  EntitlementsInputError,
  type OrganizationEntitlements,
  planIdOf,
} from './entitlements-admin.service';
export { entitlementsErrors } from './entitlements-errors';
export { EntitlementsModule } from './entitlements.module';
export { featuresOf, REQUIRED_FEATURE_KEY, RequireFeature } from './require-feature.decorator';
export { NO_ENTITLEMENTS, type ResolvedEntitlements, type ResolvedLimits } from './resolve';
