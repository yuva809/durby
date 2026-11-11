// Public API of platform/config/entitlements: the check (services, guard, jobs) and the
// @RequireFeature decorator. EntitlementsAdmin is for the entitlements CLI, onboarding and the staff
// portal (platform/staff) only.
export { ACTIVE_ENTITLEMENTS_LOOKUP, type ActiveEntitlementsLookup } from './active-entitlements';
export { EntitlementService } from './entitlement.service';
export {
  type ChangeMeta,
  type Changed,
  dependenciesOf,
  EntitlementsAdmin,
  EntitlementsDependencyError,
  EntitlementsInputError,
  type FeatureSource,
  type FeatureState,
  type OrganizationEntitlements,
  type OverrideChange,
  type PlanChange,
  planIdOf,
  type StoredOverride,
} from './entitlements-admin.service';
export { entitlementsErrors } from './entitlements-errors';
export { EntitlementsModule } from './entitlements.module';
export { featuresOf, REQUIRED_FEATURE_KEY, RequireFeature } from '../../markers';
export {
  isExpired,
  NO_ENTITLEMENTS,
  type ResolvedEntitlements,
  type ResolvedLimits,
} from './resolve';
