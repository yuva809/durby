import { Body, Controller, Get, Post } from '@nestjs/common';
import { type Feedback, type SendFeedbackRequest, sendFeedbackRequestSchema } from '@durby/shared';
import { ZodBody } from '../http';
import { Idempotent } from '../idempotency';
import { RequirePermission } from '../rbac';
import { FeedbackService } from './feedback.service';

/** /api/v1/feedback (docs/platform/feedback.md): send feedback to the Durby team and see what was sent. */
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @RequirePermission('platform.feedback.send')
  @Get()
  async list(): Promise<{ data: Feedback[] }> {
    return { data: await this.feedback.own() };
  }

  @RequirePermission('platform.feedback.send')
  @Idempotent({ completion: 'transaction' })
  @Post()
  send(@Body(new ZodBody(sendFeedbackRequestSchema)) body: SendFeedbackRequest): Promise<Feedback> {
    return this.feedback.send(body);
  }
}
