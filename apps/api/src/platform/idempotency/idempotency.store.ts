import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { IDEMPOTENCY_KEY_TTL_HOURS } from '@durby/shared';
import { TENANT_PRISMA, type TenantPrismaClient, type TenantTransactionClient } from '../tenancy';

/** How long a started request owns its key before a retry may take it over (ADR 0014 §4). */
export const LOCK_SECONDS = 120;

export interface KeyScope {
  tenantId: string;
  userId: string;
  route: string;
  key: string;
}

/** The request that owns a key right now; completion must match its lock token. */
export interface KeyLease {
  id: string;
  lockToken: string;
  takenOver: boolean;
}

export type BeginResult =
  | { kind: 'started'; lease: KeyLease }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'reused' }
  | { kind: 'in_progress' };

interface ExistingRow {
  id: string;
  requestHash: string;
  status: 'in_progress' | 'completed';
  responseStatus: number | null;
  responseBody: unknown;
  expired: boolean;
  locked: boolean;
}

/**
 * idempotency_keys (docs/platform/idempotency.md → Model). Every time comparison uses the
 * database clock. All calls run in the tenant's context: the table has RLS.
 */
@Injectable()
export class IdempotencyStore {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient) {}

  /** Starts, replays, refuses or takes over the key, in one short transaction. */
  begin(scope: KeyScope, hash: string): Promise<BeginResult> {
    return this.db.$transaction(async (tx) => {
      const lockToken = randomUUID();
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO idempotency_keys
          (tenant_id, user_id, route, key, request_hash, lock_token, locked_until, expires_at)
        VALUES (${scope.tenantId}::uuid, ${scope.userId}::uuid, ${scope.route}, ${scope.key},
          ${hash}, ${lockToken}::uuid, now() + make_interval(secs => ${LOCK_SECONDS}),
          now() + make_interval(hours => ${IDEMPOTENCY_KEY_TTL_HOURS}))
        ON CONFLICT (tenant_id, user_id, route, key) DO NOTHING
        RETURNING id::text AS id`;
      if (inserted[0]) {
        return { kind: 'started', lease: { id: inserted[0].id, lockToken, takenOver: false } };
      }

      const [row] = await tx.$queryRaw<ExistingRow[]>`
        SELECT id::text AS id, request_hash AS "requestHash", status::text AS status,
               response_status AS "responseStatus", response_body AS "responseBody",
               expires_at <= now() AS expired, locked_until > now() AS locked
        FROM idempotency_keys
        WHERE tenant_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid
          AND route = ${scope.route} AND key = ${scope.key}
        FOR UPDATE`;
      // Deleted between the insert and the select (expiry cleanup, a released 5xx): retry once.
      if (!row) return { kind: 'in_progress' };

      if (row.expired) {
        await tx.$executeRaw`
          UPDATE idempotency_keys
          SET request_hash = ${hash}, status = 'in_progress', response_status = NULL,
              response_body = NULL, completed_at = NULL, lock_token = ${lockToken}::uuid,
              locked_until = now() + make_interval(secs => ${LOCK_SECONDS}), created_at = now(),
              expires_at = now() + make_interval(hours => ${IDEMPOTENCY_KEY_TTL_HOURS})
          WHERE id = ${row.id}::uuid`;
        return { kind: 'started', lease: { id: row.id, lockToken, takenOver: false } };
      }
      if (row.requestHash !== hash) return { kind: 'reused' };
      if (row.status === 'completed') {
        return { kind: 'replay', status: row.responseStatus ?? 200, body: row.responseBody };
      }
      if (row.locked) return { kind: 'in_progress' };

      await tx.$executeRaw`
        UPDATE idempotency_keys
        SET lock_token = ${lockToken}::uuid,
            locked_until = now() + make_interval(secs => ${LOCK_SECONDS})
        WHERE id = ${row.id}::uuid`;
      return { kind: 'started', lease: { id: row.id, lockToken, takenOver: true } };
    });
  }

  /** Stores the result if `lease` still owns the key; false when it was taken over meanwhile. */
  async complete(lease: KeyLease, status: number, body: unknown): Promise<boolean> {
    return (await this.completeWith(this.db, lease, status, body)) > 0;
  }

  /** The same inside a business transaction (ADR 0014 §6). */
  async completeIn(
    tx: TenantTransactionClient,
    lease: KeyLease,
    status: number,
    body: unknown,
  ): Promise<boolean> {
    return (await this.completeWith(tx, lease, status, body)) > 0;
  }

  /** Releases the key (5xx, unstorable body) so a retry runs again. */
  async release(lease: KeyLease): Promise<void> {
    await this.db.$executeRaw`
      DELETE FROM idempotency_keys
      WHERE id = ${lease.id}::uuid AND lock_token = ${lease.lockToken}::uuid
        AND status = 'in_progress'`;
  }

  /** Expired keys of `tx`'s tenant (RLS); at most `limit` per call (retention). */
  deleteExpiredOfCurrentTenant(tx: TenantTransactionClient, limit = 10_000): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM idempotency_keys WHERE id IN (
        SELECT id FROM idempotency_keys WHERE expires_at < now() LIMIT ${limit})`;
  }

  private completeWith(
    client: TenantPrismaClient | TenantTransactionClient,
    lease: KeyLease,
    status: number,
    body: unknown,
  ): Promise<number> {
    return client.$executeRaw`
      UPDATE idempotency_keys
      SET status = 'completed', response_status = ${status},
          response_body = ${JSON.stringify(body ?? null)}::jsonb, completed_at = now()
      WHERE id = ${lease.id}::uuid AND lock_token = ${lease.lockToken}::uuid
        AND status = 'in_progress'`;
  }
}
