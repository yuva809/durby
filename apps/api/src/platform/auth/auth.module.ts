import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenService } from './access-token.service';
import { AuthContext } from './auth-context';
import { AuthGuard } from './auth.guard';
import { Clock } from './clock';
import { LockoutService } from './lockout.service';
import { OriginGuard } from './origin.guard';
import { PasswordHasher } from './password-hasher';
import { RevocationService } from './revocation.service';

/** Back-office authentication (docs/platform/auth.md). The AuthGuard runs on every route. */
@Global()
@Module({
  providers: [
    AccessTokenService,
    AuthContext,
    Clock,
    LockoutService,
    OriginGuard,
    PasswordHasher,
    RevocationService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthContext],
})
export class AuthModule {}
