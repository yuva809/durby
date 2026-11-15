import { Injectable } from '@nestjs/common';
import { EVENT_PAYLOAD_MAX_BYTES, EVENTS, type NewEvent } from '@durby/shared';
import type { z } from 'zod';
import type { Prisma } from '../database/generated/client';
import { TenantContext, type TenantTransactionClient } from '../tenancy';
import { OUTBOX_CHANNEL } from './wakeup';

/** A writer passed a payload its event's schema rejects: a programming error, never user input. */
export class OutboxPayloadInvalidError extends Error {
  readonly code = 'outbox.payload_invalid';

  constructor(type: string, detail: string) {
    super(`Invalid payload for ${type}: ${detail}`);
    this.name = 'OutboxPayloadInvalidError';
  }
}

/**
 * Writes outbox events (docs/platform/outbox.md, ADR 0013). Always inside the transaction of the
 * change, so the event exists if and only if the change commits. There is deliberately no API
 * without a transaction. The worker publishes committed events; see OutboxDispatcher.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly tenantContext: TenantContext) {}

  /** Validates the payload against the event's current version and inserts it; returns the id. */
  async add(tx: TenantTransactionClient, event: NewEvent): Promise<string> {
    const { tenantId } = this.tenantContext.require();
    const definition = EVENTS[event.type];
    const schema = (definition.versions as Readonly<Record<number, z.ZodObject>>)[
      definition.current
    ];
    if (!schema) throw new OutboxPayloadInvalidError(event.type, 'no schema for current version');
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
      throw new OutboxPayloadInvalidError(event.type, `fields ${paths.join(', ')}`);
    }
    const payload = parsed.data as Prisma.InputJsonObject;
    if (Buffer.byteLength(JSON.stringify(payload)) > EVENT_PAYLOAD_MAX_BYTES) {
      throw new OutboxPayloadInvalidError(
        event.type,
        `larger than ${EVENT_PAYLOAD_MAX_BYTES} bytes`,
      );
    }
    // Raw insert: the database sets occurred_at and available_at. Prisma fills @default(now())
    // on the client, and an app clock ahead of the database would delay the event's dispatch.
    // The same statement notifies OUTBOX_CHANNEL; Postgres delivers it only if the transaction
    // commits (once per transaction), which wakes the worker (ADR 0044 §5).
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      WITH inserted AS (
        INSERT INTO outbox_events (tenant_id, type, version, payload)
        VALUES (${tenantId}::uuid, ${event.type}, ${definition.current}, ${JSON.stringify(payload)}::jsonb)
        RETURNING id
      ), notified AS (SELECT pg_notify(${OUTBOX_CHANNEL}, ''))
      SELECT inserted.id::text AS id FROM inserted, notified`;
    if (!row) throw new Error('outbox insert returned no row');
    return row.id;
  }
}
