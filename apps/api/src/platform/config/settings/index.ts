// Public API of platform/config/settings: resolved values (services, jobs) and the in-use check
// registry for data-bound settings. Writes go through the HTTP API, or through SettingsAdmin for a
// module's delegated location writes of its own keys (ADR 0020).
export { type SettingInUseCheck, SettingInUseChecks, type SettingScopeRef } from './in-use';
export { type ResolvedSettings, type ResolvedSettingValue } from './resolve';
export { settingsErrors } from './settings-errors';
export { type SettingsAt, SettingsService } from './settings.service';
export { SettingsModule } from './settings.module';
export { type DelegatedSettingsWrite, SettingsAdmin } from './settings-admin.service';
