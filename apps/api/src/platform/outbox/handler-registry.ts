import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import {
  EVENT_HANDLER_PATTERN,
  EVENTS,
  type EventType,
  isEventType,
  isEventVersion,
} from '@durby/shared';
import type { TenantTransactionClient } from '../tenancy';
import { ON_EVENT_METADATA, type OnEventMetadata } from './on-event.decorator';

/** An event as a handler receives it: payload already validated against its version. */
export interface OutboxEvent<T extends EventType = EventType> {
  id: string;
  tenantId: string;
  type: T;
  version: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export type HandlerFn = (event: OutboxEvent, tx: TenantTransactionClient) => Promise<void>;

export interface RegisteredHandler {
  name: string;
  type: EventType;
  versions: readonly number[];
  fn: HandlerFn;
}

export class OutboxHandlerError extends Error {
  readonly code = 'outbox.handler_invalid';

  constructor(problems: string[]) {
    super(`Invalid outbox handlers (docs/platform/outbox.md):\n- ${problems.join('\n- ')}`);
    this.name = 'OutboxHandlerError';
  }
}

/**
 * Problems with declared handlers: unknown types or versions, handler names not
 * `module.camelCaseName`, duplicate names, versions without the type's current one. Pure, so the
 * check is unit-tested; the registry throws at boot when any is found.
 */
export function handlerProblems(declared: readonly OnEventMetadata[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { type, handler, versions } of declared) {
    // Declared types are typed, but a handler may come from code built against another registry.
    if (!isEventType(type)) {
      problems.push(`${handler}: unknown event type ${type as string}`);
      continue;
    }
    if (!EVENT_HANDLER_PATTERN.test(handler)) {
      problems.push(`${handler}: handler name must be module.camelCaseName`);
    }
    if (seen.has(handler)) problems.push(`${handler}: duplicate handler name`);
    seen.add(handler);
    const current = EVENTS[type].current;
    const accepted = versions ?? [current];
    for (const v of accepted) {
      if (!isEventVersion(type, v)) problems.push(`${handler}: ${type} has no version ${v}`);
    }
    if (!accepted.includes(current)) {
      problems.push(`${handler}: must read the current version ${current} of ${type}`);
    }
  }
  return problems;
}

/**
 * Discovers @OnEvent methods at boot (api and worker), so a bad handler fails every process that
 * would run it. The dispatcher fans each event out to the handlers registered for its type.
 */
@Injectable()
export class OutboxHandlerRegistry implements OnModuleInit {
  private readonly byType = new Map<EventType, RegisteredHandler[]>();
  private readonly byName = new Map<string, RegisteredHandler>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const found: { meta: OnEventMetadata; fn: HandlerFn }[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) continue;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const fn = (instance as Record<string, unknown>)[method];
        if (typeof fn !== 'function') continue;
        const meta = Reflect.getMetadata(ON_EVENT_METADATA, fn) as OnEventMetadata | undefined;
        if (meta) found.push({ meta, fn: (fn as HandlerFn).bind(instance) });
      }
    }
    const problems = handlerProblems(found.map((f) => f.meta));
    if (problems.length > 0) throw new OutboxHandlerError(problems);
    for (const { meta, fn } of found) {
      const handler: RegisteredHandler = {
        name: meta.handler,
        type: meta.type,
        versions: meta.versions ?? [EVENTS[meta.type].current],
        fn,
      };
      this.byName.set(handler.name, handler);
      this.byType.set(meta.type, [...(this.byType.get(meta.type) ?? []), handler]);
    }
  }

  /** Handlers of a type that read `version`. */
  handlersFor(type: EventType, version: number): RegisteredHandler[] {
    return (this.byType.get(type) ?? []).filter((h) => h.versions.includes(version));
  }

  handler(name: string): RegisteredHandler | undefined {
    return this.byName.get(name);
  }
}
