import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditModule } from './audit';
import { AuthModule } from './auth';
import { ConfigModule } from './config';
import { EntitlementsModule } from './config/entitlements';
import { SettingsModule } from './config/settings';
import { DatabaseModule } from './database';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { IdempotencyModule } from './idempotency';
import { ApiExceptionFilter } from './http';
import { LabelsModule } from './labels';
import { LoggingModule } from './logging';
import { MailModule } from './mail';
import { NumberingModule } from './numbering';
import { OrganizationModule } from './organization';
import { OutboxModule } from './outbox';
import { ProvisioningModule } from './provisioning';
import { RateLimitModule } from './rate-limit';
import { RbacModule } from './rbac';
import { RealtimeModule } from './realtime';
import { RedisModule } from './redis';
import { StaffModule } from './staff';
import { TenancyModule } from './tenancy';
import { ThemeModule } from './theme';
import { FeedbackModule } from './feedback';
import { NotificationsModule } from './notifications';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    TenancyModule,
    RedisModule,
    RateLimitModule,
    MailModule,
    AuditModule,
    OutboxModule,
    RealtimeModule,
    IdempotencyModule,
    AuthModule,
    StaffModule,
    EntitlementsModule,
    RbacModule,
    SettingsModule,
    LabelsModule,
    NumberingModule,
    OrganizationModule,
    ProvisioningModule,
    ThemeModule,
    FeedbackModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [HealthService, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class PlatformModule {}
