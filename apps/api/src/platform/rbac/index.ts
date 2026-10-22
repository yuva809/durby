// Public API of platform/rbac: route markers and the caller's access. Everything else is internal.
export { AccessService } from './access.service';
export { IS_PLATFORM_ONLY_KEY, PlatformOnly } from './platform-only.decorator';
export { PERMISSION_REGISTRY, type PermissionRegistry } from './permission-registry';
export { RbacModule } from './rbac.module';
export { REQUIRED_PERMISSION_KEY, RequirePermission } from './require-permission.decorator';
export {
  findRouteMarkerProblems,
  listRoutes,
  type RouteInfo,
  type RouteMarker,
  RouteMarkerError,
} from './route-markers';
