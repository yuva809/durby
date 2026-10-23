// Public API of platform/config/settings: resolved values (services, jobs) and the in-use check
// registry for data-bound settings. Writes go through the HTTP API only.
export { type SettingInUseCheck, SettingInUseChecks, type SettingScopeRef } from './in-use';
export { type ResolvedSettings, type ResolvedSettingValue } from './resolve';
export { settingsErrors } from './settings-errors';
export { type SettingsAt, SettingsService } from './settings.service';
// The Nest module is exported last: platform folders depend on each other's services and
// decorators, so a partly loaded index (import cycle through a module) must already export them.
export { SettingsModule } from './settings.module';
