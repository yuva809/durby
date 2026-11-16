import { Inject, Injectable } from '@nestjs/common';
import {
  type Feedback,
  FEEDBACK_OWN_LIST_LIMIT,
  type FeedbackCategory,
  type FeedbackStatus,
  type SendFeedbackRequest,
} from '@durby/shared';
import { IdempotencyService } from '../idempotency';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';

const FEEDBACK_SELECT = {
  id: true,
  category: true,
  message: true,
  pagePath: true,
  status: true,
  createdAt: true,
} as const;

interface FeedbackRow {
  id: string;
  category: FeedbackCategory;
  message: string;
  pagePath: string | null;
  status: FeedbackStatus;
  createdAt: Date;
}

/**
 * Feedback to the Durby team, the customer side (docs/platform/feedback.md, ADR 0044 step 5). The table is platform
 * data without RLS, so every query here names the session's organization; nothing else reads or writes it from a
 * tenant request. No audit row: the feedback itself is the record, and the message is free text.
 */
@Injectable()
export class FeedbackService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** In a tenant transaction, so the idempotency key completes with the row (rule 8). */
  send(body: SendFeedbackRequest): Promise<Feedback> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      const row = await tx.feedback.create({
        data: {
          organizationId: tenantId,
          userId,
          category: body.category,
          message: body.message,
          pagePath: body.pagePath ?? null,
        },
        select: FEEDBACK_SELECT,
      });
      const response = feedbackResponse(row);
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** The organization's feedback, newest first: what was sent and where it stands. */
  async own(): Promise<Feedback[]> {
    const { tenantId } = this.tenantContext.require();
    const rows = await this.db.feedback.findMany({
      where: { organizationId: tenantId },
      select: FEEDBACK_SELECT,
      orderBy: { id: 'desc' },
      take: FEEDBACK_OWN_LIST_LIMIT,
    });
    return rows.map(feedbackResponse);
  }
}

export function feedbackResponse(row: FeedbackRow): Feedback {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
