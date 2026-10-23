// Public API of platform/outbox: events are written inside the caller's transaction; handlers are
// methods decorated with @OnEvent and run by the worker (docs/platform/outbox.md).
export { type CleanupCounts, OutboxCleanup, type RetentionTask } from './cleanup';
export { type DispatchResult, OutboxDispatcher, type TenantBacklog } from './dispatcher';
export { OutboxEventRunner, type RunOutcome } from './event-runner';
export { type OutboxEvent } from './handler-registry';
export { type OutboxLag, OutboxLagReporter } from './lag-reporter';
export { OnEvent, type OnEventOptions } from './on-event.decorator';
export {
  type DeadLetter,
  type HandlerFailure,
  OutboxAdmin,
  OutboxAdminError,
} from './outbox-admin';
export { type HandlerJobData, handlerJobId, OutboxPublisher } from './outbox-queue';
export { HEARTBEAT_FILE, OutboxWorker } from './outbox-worker';
export { OutboxPayloadInvalidError, OutboxService } from './outbox.service';
// The Nest module is exported last: platform folders depend on each other's services and
// decorators, so a partly loaded index (import cycle through a module) must already export them.
export { OutboxModule } from './outbox.module';
