// Public API of platform/config/settings: resolved values (services, jobs) and the in-use check
// registry for data-bound settings. Writes go through the HTTP API only.
export { type SettingInUseCheck, SettingInUseChecks, type SettingScopeRef } from './in-use';
export { type ResolvedSettings, type ResolvedSettingValue } from './resolve';
export { settingsErrors } from './settings-errors';
export { SettingsModule } from './settings.module';
export { type SettingsAt, SettingsService } from './settings.service';
