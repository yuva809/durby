// Public API of platform/rbac: route markers and the caller's access. Everything else is internal.
export { AccessService } from './access.service';
export {
  INVITATION_LABELS,
  INVITATION_SETTINGS,
  type InvitationLabels,
  type InvitationSettings,
} from './invitation-ports';
export { IS_PLATFORM_ONLY_KEY, PlatformOnly } from '../markers';
export { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';
export { STAFF_AUTHENTICATOR, type StaffAuthenticatorPort } from './staff-port';
export { SystemRoles } from './system-roles';
export { REQUIRED_PERMISSION_KEY, RequirePermission } from '../markers';
export {
  findRouteMarkerProblems,
  listRoutes,
  markersOf,
  type RouteInfo,
  type RouteMarker,
  RouteMarkerError,
} from './route-markers';
export { RbacModule } from './rbac.module';
