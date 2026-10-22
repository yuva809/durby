import { Global, Module } from '@nestjs/common';
import { AccessTokenService } from './access-token.service';
import { AuthContext } from './auth-context';
import { AuthController } from './auth.controller';
import { AuthMailer } from './auth-mailer';
import { Authenticator } from './authenticator';
import { AuthRateLimits } from './auth-rate-limits';
import { Clock } from './clock';
import { LockoutService } from './lockout.service';
import { MembershipLookup } from './membership-lookup';
import { OriginGuard } from './origin.guard';
import { PasswordHasher } from './password-hasher';
import { PasswordService } from './password.service';
import { RefreshTokenStore } from './refresh-token.store';
import { RevocationService } from './revocation.service';
import { SecurityLog } from './security-log';
import { SessionService } from './session.service';
import { UserDirectory } from './user-directory';

/**
 * Back-office authentication (docs/platform/auth.md). The global AccessGuard (platform/rbac) calls
 * the Authenticator on every route that isn't @Public().
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    AuthContext,
    AuthMailer,
    Authenticator,
    AuthRateLimits,
    Clock,
    LockoutService,
    MembershipLookup,
    OriginGuard,
    PasswordHasher,
    PasswordService,
    RefreshTokenStore,
    RevocationService,
    SecurityLog,
    SessionService,
    UserDirectory,
  ],
  exports: [AuthContext, Authenticator, PasswordService, RevocationService, UserDirectory],
})
export class AuthModule {}
