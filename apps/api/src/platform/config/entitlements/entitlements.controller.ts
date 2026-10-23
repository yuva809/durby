import { Controller, Get, Inject } from '@nestjs/common';
import type { MeEntitlementsResponse } from '@durby/shared';
import { AuthContext, Authenticated } from '../../auth';
import { ACTIVE_ENTITLEMENTS_LOOKUP, type ActiveEntitlementsLookup } from './active-entitlements';
import { NO_ENTITLEMENTS, type ResolvedEntitlements } from './resolve';

/** The caller's active organization's enabled features (docs/platform/entitlements.md). */
@Controller('me')
export class EntitlementsController {
  constructor(
    private readonly auth: AuthContext,
    @Inject(ACTIVE_ENTITLEMENTS_LOOKUP) private readonly active: ActiveEntitlementsLookup,
  ) {}

  /** ADR 0009 §6: only the token's active organization, only for a member of it. UI hint. */
  @Authenticated()
  @Get('entitlements')
  async mine(): Promise<MeEntitlementsResponse> {
    const { userId, organizationId } = this.auth.require();
    const entitlements =
      organizationId === null
        ? NO_ENTITLEMENTS
        : await this.active.entitlementsOf(organizationId, userId);
    return toResponse(entitlements);
  }
}

export function toResponse(entitlements: ResolvedEntitlements): MeEntitlementsResponse {
  return {
    plan: entitlements.planKey === null ? null : { key: entitlements.planKey },
    features: [...entitlements.features].map(([key, limits]) => ({ key, limits: { ...limits } })),
  };
}
