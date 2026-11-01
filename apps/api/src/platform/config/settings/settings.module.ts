import { Global, Module } from '@nestjs/common';
import { INVITATION_SETTINGS } from '../../rbac';
import { SettingInUseChecks } from './in-use';
import { SettingsAdmin } from './settings-admin.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Inherited settings (docs/platform/settings.md). Depends on tenancy, audit and rbac; rbac reads the
 * organization's locale through INVITATION_SETTINGS (no import of settings); modules read
 * settings through SettingsService and register data-bound checks with SettingInUseChecks.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [
    SettingsService,
    SettingsAdmin,
    SettingInUseChecks,
    { provide: INVITATION_SETTINGS, useExisting: SettingsService },
  ],
  exports: [SettingsService, SettingsAdmin, SettingInUseChecks, INVITATION_SETTINGS],
})
export class SettingsModule {}
