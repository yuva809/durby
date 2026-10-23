import type { ResolvedEntitlements } from './resolve';

/**
 * The enabled features of the token's active organization, for `/me/entitlements` (ADR 0009 §6).
 * Provided by platform/rbac, which checks that `userId` is a member of `organizationId` first; no
 * membership → NO_ENTITLEMENTS. Reads through the tenant client under RLS. UI hints only: the api
 * still checks @RequireFeature per request.
 */
export interface ActiveEntitlementsLookup {
  entitlementsOf(organizationId: string, userId: string): Promise<ResolvedEntitlements>;
}

export const ACTIVE_ENTITLEMENTS_LOOKUP = Symbol('ACTIVE_ENTITLEMENTS_LOOKUP');
