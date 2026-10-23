// Public API of platform/rbac: route markers and the caller's access. Everything else is internal.
export { AccessService } from './access.service';
export { IS_PLATFORM_ONLY_KEY, PlatformOnly } from './platform-only.decorator';
export { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';
export { SystemRoles } from './system-roles';
export { REQUIRED_PERMISSION_KEY, RequirePermission } from './require-permission.decorator';
export {
  findRouteMarkerProblems,
  listRoutes,
  type RouteInfo,
  type RouteMarker,
  RouteMarkerError,
} from './route-markers';
// The Nest module is exported last: platform folders depend on each other's services and
// decorators, so a partly loaded index (import cycle through a module) must already export them.
export { RbacModule } from './rbac.module';
