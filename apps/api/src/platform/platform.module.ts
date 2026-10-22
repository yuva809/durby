import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth';
import { ConfigModule } from './config';
import { DatabaseModule } from './database';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { ApiExceptionFilter } from './http';
import { LoggingModule } from './logging';
import { MailModule } from './mail';
import { ProvisioningModule } from './provisioning';
import { RateLimitModule } from './rate-limit';
import { RbacModule } from './rbac';
import { RedisModule } from './redis';
import { TenancyModule } from './tenancy';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    TenancyModule,
    RedisModule,
    RateLimitModule,
    MailModule,
    AuthModule,
    RbacModule,
    ProvisioningModule,
  ],
  controllers: [HealthController],
  providers: [HealthService, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class PlatformModule {}
