// Public API of platform/numbering: allocation inside the caller's transaction. Series change
// through the HTTP API only.
export { numberingErrors } from './numbering-errors';
export { type AllocatedNumber, NumberingService } from './numbering.service';
// The Nest module is exported last: platform folders depend on each other's services and
// decorators, so a partly loaded index (import cycle through a module) must already export them.
export { NumberingModule } from './numbering.module';
