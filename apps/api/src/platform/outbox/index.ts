// Public API of platform/outbox: events are written inside the caller's transaction; handlers are
// methods decorated with @OnEvent and run by the worker (docs/platform/outbox.md).
export { OutboxPayloadInvalidError, OutboxService } from './outbox.service';
// The Nest module is exported last: platform folders depend on each other's services and
// decorators, so a partly loaded index (import cycle through a module) must already export them.
export { OutboxModule } from './outbox.module';
