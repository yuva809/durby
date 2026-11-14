import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  AuditAction,
  AuditLogActor,
  AuditEntityType,
  AuditLogEntry,
  AuditLogListResponse,
  AuditLogQuery,
  AuditSystemActor,
} from '@durby/shared';
import type { Prisma } from '../database/generated/client';
import { ApiError } from '../http';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';
import { AUDIT_ACTOR_DIRECTORY, type AuditActorDirectory } from './audit-actor-directory';
import { decodeCursor, encodeCursor } from './audit-cursor';

export const auditErrors = {
  cursorInvalid: () =>
    new ApiError(HttpStatus.BAD_REQUEST, 'audit.cursor_invalid', 'Invalid page cursor.'),
};

const AUDIT_LOG_SELECT = {
  id: true,
  actorType: true,
  actorUserId: true,
  actorSystem: true,
  action: true,
  entityType: true,
  entityId: true,
  before: true,
  after: true,
  requestId: true,
  ip: true,
  createdAt: true,
} as const;

type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_LOG_SELECT }>;

/** Reads the active organization's audit log (docs/platform/audit.md → Endpoint). */
@Injectable()
export class AuditLogsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    @Inject(AUDIT_ACTOR_DIRECTORY) private readonly actors: AuditActorDirectory,
  ) {}

  /** Newest first by uuid v7 id; `limit + 1` rows tell whether another page exists. */
  async list(query: AuditLogQuery): Promise<AuditLogListResponse> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (after === null) throw auditErrors.cursorInvalid();
    // RLS already limits rows to the tenant; the explicit filter keeps the plan on the indexes.
    const { tenantId } = this.tenantContext.require();
    const rows = await this.db.auditLog.findMany({
      where: {
        tenantId,
        ...(after !== undefined && { id: { lt: after } }),
        ...(query.action && { action: { in: query.action } }),
        ...(query.entityType && { entityType: query.entityType }),
        ...(query.entityId && { entityId: query.entityId }),
        ...(query.actorUserId && { actorUserId: query.actorUserId }),
        // Module and branch (the audit page's filters): the action's prefix, and the record's location in either
        // snapshot (snapshots carry `locationId` for location-bound records).
        AND: [
          ...(query.module ? [{ action: { startsWith: `${query.module}.` } }] : []),
          ...(query.locationId
            ? [
                {
                  OR: [
                    { after: { path: ['locationId'], equals: query.locationId } },
                    { before: { path: ['locationId'], equals: query.locationId } },
                  ],
                },
              ]
            : []),
        ],
        ...((query.from ?? query.to) !== undefined && {
          createdAt: {
            ...(query.from && { gte: new Date(query.from) }),
            ...(query.to && { lt: new Date(query.to) }),
          },
        }),
      },
      select: AUDIT_LOG_SELECT,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    // Display only: the emails of this page's user actors, looked up now, never stored.
    const userIds = [...new Set(page.flatMap((r) => (r.actorUserId ? [r.actorUserId] : [])))];
    const emails = await this.actors.emails(userIds);
    return {
      data: page.map((row) => toEntry(row, emails)),
      meta: {
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
        limit: query.limit,
      },
    };
  }
}

function toEntry(row: AuditLogRow, emails: ReadonlyMap<string, string>): AuditLogEntry {
  return {
    id: row.id,
    actor: actorOf(row, emails),
    action: row.action as AuditAction,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId,
    before: row.before as AuditLogEntry['before'],
    after: row.after as AuditLogEntry['after'],
    requestId: row.requestId,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

function actorOf(row: AuditLogRow, emails: ReadonlyMap<string, string>): AuditLogActor {
  if (row.actorType === 'user' && row.actorUserId) {
    return { type: 'user', userId: row.actorUserId, email: emails.get(row.actorUserId) ?? null };
  }
  if (row.actorType === 'system' && row.actorSystem) {
    return { type: 'system', key: row.actorSystem as AuditSystemActor };
  }
  // audit_logs_actor_check rules this out.
  throw new Error(`audit log ${row.id} has no actor`);
}
