import { Global, Module } from '@nestjs/common';
import { SettingInUseChecks } from './in-use';
import { SettingsAdmin } from './settings-admin.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Inherited settings (docs/platform/settings.md). Depends on tenancy, audit and rbac; modules read
 * settings through SettingsService and register data-bound checks with SettingInUseChecks.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, SettingsAdmin, SettingInUseChecks],
  exports: [SettingsService, SettingInUseChecks],
})
export class SettingsModule {}
