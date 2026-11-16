import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import {
  type StaffFeedback,
  type StaffFeedbackListQuery,
  staffFeedbackListQuerySchema,
  type StaffFeedbackListResponse,
  type UpdateFeedbackStatusRequest,
  updateFeedbackStatusRequestSchema,
} from '@durby/shared';
import { ZodBody, ZodQuery } from '../http';
import { IdempotencyExempt, PlatformOnly } from '../markers';
import { StaffContext } from './staff-context';
import { staffErrors } from './staff-errors';
import { StaffFeedbackService } from './staff-feedback.service';

/** /api/v1/platform/feedback (docs/platform/feedback.md, ADR 0044 step 5): customers' feedback to the Durby team. */
@Controller('platform/feedback')
export class StaffFeedbackController {
  constructor(
    private readonly feedback: StaffFeedbackService,
    private readonly context: StaffContext,
  ) {}

  @PlatformOnly('staff.feedback.read')
  @Get()
  async list(
    @Query(new ZodQuery(staffFeedbackListQuerySchema)) query: StaffFeedbackListQuery,
  ): Promise<StaffFeedbackListResponse> {
    return { data: await this.feedback.list(query) };
  }

  @PlatformOnly('staff.feedback.manage')
  @IdempotencyExempt('staff write: sets a status, the same request again changes nothing')
  @Patch(':id')
  setStatus(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: staffErrors.feedbackNotFound })) id: string,
    @Body(new ZodBody(updateFeedbackStatusRequestSchema)) body: UpdateFeedbackStatusRequest,
  ): Promise<StaffFeedback> {
    return this.feedback.setStatus(this.context.require().staffId, id, body.status);
  }
}
