import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditActionEntityType,
  type AuditActor,
  type AuditSystemActor,
} from '@durby/shared';
import { Prisma } from '../database/generated/client';
import { TenantContext, type TenantTransactionClient } from '../tenancy';
import type { Snapshot } from './audit-snapshots';
import { RequestInfo } from './request-info';

export const auditActor = {
  user: (userId: string): AuditActor => ({ type: 'user', userId }),
  system: (key: AuditSystemActor): AuditActor => ({ type: 'system', key }),
};

export interface AuditEntry<A extends AuditAction> {
  action: A;
  actor: AuditActor;
  entityId: string;
  /** null/absent on create. */
  before?: Snapshot<AuditActionEntityType<A>> | null;
  /** null/absent on delete. */
  after?: Snapshot<AuditActionEntityType<A>> | null;
}

/**
 * Writes audit rows (docs/platform/audit.md, ADR 0008). Always inside the transaction of the change,
 * so the row commits or rolls back with it. There is deliberately no API without a transaction.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly requestInfo: RequestInfo,
  ) {}

  async record<A extends AuditAction>(
    tx: TenantTransactionClient,
    entry: AuditEntry<A>,
  ): Promise<void> {
    const { tenantId } = this.tenantContext.require();
    const { requestId, ip } = this.requestInfo.current();
    const { actor } = entry;
    await tx.auditLog.create({
      data: {
        tenantId,
        actorType: actor.type,
        actorUserId: actor.type === 'user' ? actor.userId : null,
        actorSystem: actor.type === 'system' ? actor.key : null,
        action: entry.action,
        entityType: AUDIT_ACTIONS[entry.action].entityType,
        entityId: entry.entityId,
        before: json(entry.before),
        after: json(entry.after),
        requestId,
        ip,
      },
      select: { id: true },
    });
  }
}

function json(value: object | null | undefined): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return value == null ? Prisma.DbNull : value;
}
