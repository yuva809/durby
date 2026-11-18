import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { authErrors } from './auth-errors';

export interface AuthContextValue {
  userId: string;
  /** Active organization (tenant) of the access token, or null. */
  organizationId: string | null;
  /** Refresh token family of the session. */
  sessionId: string;
  /** Only the password change, /auth/me and logout are open (ADR 0023 §3). */
  passwordChangeRequired: boolean;
  /** The access token's iat and exp (seconds): long-lived responses end at exp (ADR 0044 §7). */
  issuedAt: number;
  expiresAt: number;
}

const CLS_KEY = 'durby:auth';

/** The authenticated user of the current request, set by the AuthGuard from the verified token. */
@Injectable()
export class AuthContext {
  constructor(private readonly cls: ClsService) {}

  get(): Readonly<AuthContextValue> | undefined {
    return this.cls.isActive() ? this.cls.get<AuthContextValue | undefined>(CLS_KEY) : undefined;
  }

  /** Throws 401 auth.unauthenticated outside an authenticated request. */
  require(): Readonly<AuthContextValue> {
    const ctx = this.get();
    if (!ctx) throw authErrors.unauthenticated();
    return ctx;
  }

  set(ctx: AuthContextValue): void {
    this.cls.set(CLS_KEY, Object.freeze({ ...ctx }));
  }
}
