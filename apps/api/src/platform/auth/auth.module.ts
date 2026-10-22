import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenService } from './access-token.service';
import { AuthContext } from './auth-context';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthMailer } from './auth-mailer';
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

/** Back-office authentication (docs/platform/auth.md). The AuthGuard runs on every route. */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    AuthContext,
    AuthMailer,
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
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthContext, PasswordService],
})
export class AuthModule {}
