import type { RoleRef } from '@durby/shared';

/**
 * The caller's role and effective permission keys in an organization, for the session body and
 * /auth/me (ADR 0007, amendment). Provided by platform/rbac, so auth needn't import it. Reads only
 * the membership of `userId` in `organizationId`, through RLS. UI hints only: the api still checks
 * every permission per request.
 */
export interface ActiveAccessLookup {
  lookup(organizationId: string, userId: string): Promise<ActiveAccess>;
}

export interface ActiveAccess {
  role: RoleRef | null;
  permissions: string[];
}

export const ACTIVE_ACCESS_LOOKUP = Symbol('ACTIVE_ACCESS_LOOKUP');

export const NO_ACTIVE_ACCESS: ActiveAccess = { role: null, permissions: [] };
