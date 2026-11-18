import { PERMISSIONS, type PermissionDefinition } from '@durby/shared';

/**
 * The permission registry the api checks against: PERMISSIONS from packages/shared. A provider
 * token so integration tests can add a location-scope key before module code defines real ones.
 */
export const PERMISSION_REGISTRY = Symbol('PERMISSION_REGISTRY');

/** The api reads only scope and label (the matrix cell is for the web, ADR 0050). */
export type PermissionRegistry = Readonly<
  Record<string, Pick<PermissionDefinition, 'scope' | 'label'>>
>;

export const defaultPermissionRegistry: PermissionRegistry = PERMISSIONS;
