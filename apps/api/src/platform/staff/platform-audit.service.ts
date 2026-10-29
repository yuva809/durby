import { Injectable } from '@nestjs/common';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_SNAPSHOT_FIELDS,
  type PlatformAuditAction,
  type PlatformAuditEntityType,
  type PlatformAuditSystemActor,
} from '@durby/shared';
import { Prisma } from '../database/generated/client';

export type PlatformAuditActor = { staffId: string } | { system: PlatformAuditSystemActor };

export interface PlatformAuditEntry {
  action: PlatformAuditAction;
  actor: PlatformAuditActor;
  entityId: string;
  organizationId?: string | null;
  reason?: string | null;
  before?: Prisma.InputJsonObject | null;
  after?: Prisma.InputJsonObject | null;
}

/** Only the allow-listed fields of an entity (ADR 0017 §7): never emails, hashes or secrets. */
export function platformSnapshot(
  type: PlatformAuditEntityType,
  row: Record<string, unknown>,
): Prisma.InputJsonObject {
  const out: Record<string, unknown> = {};
  for (const field of PLATFORM_AUDIT_SNAPSHOT_FIELDS[type]) out[field] = row[field] ?? null;
  return out as Prisma.InputJsonObject;
}

/**
 * Writes platform audit rows: always inside the transaction of the change. The table is
 * append-only (ADR 0017 §7).
 */
@Injectable()
export class PlatformAuditService {
  async record(tx: Prisma.TransactionClient, entry: PlatformAuditEntry): Promise<void> {
    const { actor } = entry;
    await tx.platformAuditLog.create({
      data: {
        actorStaffId: 'staffId' in actor ? actor.staffId : null,
        actorSystem: 'system' in actor ? actor.system : null,
        action: entry.action,
        entityType: PLATFORM_AUDIT_ACTIONS[entry.action].entityType,
        entityId: entry.entityId,
        organizationId: entry.organizationId ?? null,
        reason: entry.reason ?? null,
        before: entry.before ?? Prisma.DbNull,
        after: entry.after ?? Prisma.DbNull,
      },
      select: { id: true },
    });
  }
}
