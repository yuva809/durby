import { PERMISSIONS, type PermissionDefinition } from '@durby/shared';

/**
 * The permission registry the api checks against: PERMISSIONS from packages/shared. A provider
 * token so integration tests can add a location-scope key before module code defines real ones.
 */
export const PERMISSION_REGISTRY = Symbol('PERMISSION_REGISTRY');

export type PermissionRegistry = Readonly<Record<string, PermissionDefinition>>;

export const defaultPermissionRegistry: PermissionRegistry = PERMISSIONS;
