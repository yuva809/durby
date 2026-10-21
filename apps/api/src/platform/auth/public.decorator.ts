import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'durby:isPublic';

/**
 * Marks a route as reachable without authentication (CLAUDE.md hard rule 10).
 * Enforced by the global auth guard added in step 1.2.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
