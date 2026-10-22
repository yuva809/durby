import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../http';

/** Error codes of platform/rbac (docs/platform/rbac.md → Error codes). */
export const rbacErrors = {
  permissionDenied: (permission: string) =>
    new ApiError(HttpStatus.FORBIDDEN, 'rbac.permission_denied', 'Permission denied.', {
      permission,
    }),
  platformOnly: () =>
    new ApiError(HttpStatus.FORBIDDEN, 'rbac.platform_only', 'Only for platform staff.'),
  routeUnmarked: () =>
    new ApiError(HttpStatus.FORBIDDEN, 'rbac.route_unmarked', 'Route has no access marker.'),
} as const;
