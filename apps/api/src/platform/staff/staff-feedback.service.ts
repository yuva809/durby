import { Injectable } from '@nestjs/common';
import {
  FEEDBACK_STAFF_LIST_LIMIT,
  type FeedbackCategory,
  type FeedbackStatus,
  type StaffFeedback,
  type StaffFeedbackListQuery,
} from '@durby/shared';
import { UserDirectory } from '../auth';
import { PrismaService } from '../database';
import { platformSnapshot, PlatformAuditService } from './platform-audit.service';
import { staffErrors } from './staff-errors';

const SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  category: true,
  message: true,
  pagePath: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { name: true } },
} as const;

interface Row {
  id: string;
  organizationId: string;
  userId: string;
  category: FeedbackCategory;
  message: string;
  pagePath: string | null;
  status: FeedbackStatus;
  createdAt: Date;
  updatedAt: Date;
  organization: { name: string };
}

/**
 * Customers' feedback in the admin portal (docs/platform/feedback.md, ADR 0044 step 5): all of it, newest first, with
 * the customer and the sender's email; staff mark it seen or done, each change in the platform audit log.
 */
@Injectable()
export class StaffFeedbackService {
  constructor(
    private readonly db: PrismaService,
    private readonly users: UserDirectory,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  async list(query: StaffFeedbackListQuery): Promise<StaffFeedback[]> {
    const rows: Row[] = await this.db.feedback.findMany({
      where: query.status ? { status: query.status } : {},
      select: SELECT,
      orderBy: { id: 'desc' },
      take: FEEDBACK_STAFF_LIST_LIMIT,
    });
    return this.withEmails(rows);
  }

  /** Set-state: the same status again changes nothing and writes no audit row. */
  async setStatus(staffId: string, id: string, status: FeedbackStatus): Promise<StaffFeedback> {
    const row = await this.db.$transaction(async (tx) => {
      const current: Row | null = await tx.feedback.findUnique({ where: { id }, select: SELECT });
      if (!current) throw staffErrors.feedbackNotFound();
      if (current.status === status) return current;
      const updated: Row = await tx.feedback.update({
        where: { id },
        data: { status },
        select: SELECT,
      });
      await this.platformAudit.record(tx, {
        action: 'staff.feedback.status_changed',
        actor: { staffId },
        entityId: id,
        organizationId: current.organizationId,
        before: platformSnapshot('feedback', { ...current }),
        after: platformSnapshot('feedback', { ...updated }),
      });
      return updated;
    });
    const [response] = await this.withEmails([row]);
    return response!;
  }

  private async withEmails(rows: Row[]): Promise<StaffFeedback[]> {
    const profiles = await this.users.profiles([...new Set(rows.map((r) => r.userId))]);
    return rows.map((row) => ({
      id: row.id,
      category: row.category,
      message: row.message,
      pagePath: row.pagePath,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      userEmail: profiles.get(row.userId)?.email ?? null,
    }));
  }
}
