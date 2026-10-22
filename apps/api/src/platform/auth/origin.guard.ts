import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import { authErrors } from './auth-errors';

/**
 * CSRF protection for the refresh-cookie endpoints (ADR 0006): `Origin` must be one of
 * WEB_ORIGINS exactly. Browsers always send Origin on cross-site and on POST fetches; a missing
 * Origin is rejected too.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowed: ReadonlySet<string>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.allowed = new Set(config.WEB_ORIGINS);
  }

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest<Request>().headers.origin;
    if (origin === undefined || !this.allowed.has(origin)) throw authErrors.originRejected();
    return true;
  }
}

/** Requires an allowed Origin header (runs after the global AuthGuard). */
export const RequireOrigin = (): MethodDecorator & ClassDecorator => UseGuards(OriginGuard);
