/**
 * Permission key registry (`module.entity.action`). Populated in step 1.3.
 */
export const PERMISSION_KEYS = [] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
