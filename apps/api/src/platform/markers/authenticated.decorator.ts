import { SetMetadata } from '@nestjs/common';

export const IS_AUTHENTICATED_KEY = 'durby:isAuthenticated';

/**
 * A user-level route: needs a valid access token, no tenant permission (CLAUDE.md rule 10,
 * ADR 0006). Only for routes that never read or write tenant-scoped data; everything else needs
 * @RequirePermission. Listed in test/authenticated-routes.e2e.spec.ts.
 */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_AUTHENTICATED_KEY, true);
