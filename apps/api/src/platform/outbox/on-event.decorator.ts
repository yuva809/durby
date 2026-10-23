import type { EventType } from '@durby/shared';

export const ON_EVENT_METADATA = 'durby:on-event';

export interface OnEventOptions {
  /**
   * Stable name, `module.camelCaseName`. processed_events dedupes on it, so renaming a handler
   * re-delivers retained events to it.
   */
  handler: string;
  /** Payload versions it reads; must include the type's current version. Default: current only. */
  versions?: readonly number[];
}

export interface OnEventMetadata extends OnEventOptions {
  type: EventType;
}

/**
 * Marks a provider method as an outbox event handler (docs/platform/outbox.md → Handlers). It is
 * called as `method(event, tx)` in the event's tenant context and in one transaction with its
 * processed_events row; it must use only `tx` and tolerate any order. Checked at boot.
 */
export function OnEvent(type: EventType, options: OnEventOptions): MethodDecorator {
  return (_target, _key, descriptor) => {
    Reflect.defineMetadata(ON_EVENT_METADATA, { type, ...options }, descriptor.value as object);
    return descriptor;
  };
}
