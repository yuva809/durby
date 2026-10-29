import { Injectable } from '@nestjs/common';
import {
  type PlatformAuditEntry,
  type PlatformAuditQuery,
  type PlatformAuditResponse,
  platformAuditEntrySchema,
} from '@durby/shared';
import { PrismaService } from '../database';

/** Pages of the platform audit log, newest first (uuidv7 ids are time-ordered). */
@Injectable()
export class PlatformAuditReader {
  constructor(private readonly db: PrismaService) {}

  async page(query: PlatformAuditQuery): Promise<PlatformAuditResponse> {
    const rows = await this.db.platformAuditLog.findMany({
      where: query.cursor ? { id: { lt: query.cursor } } : {},
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const staffIds = [...new Set(page.flatMap((r) => (r.actorStaffId ? [r.actorStaffId] : [])))];
    const emails = new Map(
      (
        await this.db.staffAccount.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, email: true },
        })
      ).map((s) => [s.id, s.email]),
    );
    const data: PlatformAuditEntry[] = page.map((row) =>
      platformAuditEntrySchema.parse({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        actor: row.actorStaffId
          ? { type: 'staff', name: emails.get(row.actorStaffId) ?? null }
          : { type: 'system', name: row.actorSystem },
        entityType: row.entityType,
        entityId: row.entityId,
        organizationId: row.organizationId,
        reason: row.reason,
        before: row.before,
        after: row.after,
      }),
    );
    return {
      data,
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
