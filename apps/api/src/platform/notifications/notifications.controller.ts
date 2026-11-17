import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  type Notification,
  type NotificationListResponse,
  type NotificationPreference,
  type PutNotificationPreferences,
  putNotificationPreferencesSchema,
} from '@durby/shared';
import { Authenticated } from '../auth';
import { ZodBody } from '../http';
import { Idempotent } from '../idempotency';
import { notificationErrors, NotificationService } from './notification.service';

/**
 * /api/v1/notifications (docs/platform/notifications.md, ADR 0047): the signed-in person's own notifications and
 * choices. @Authenticated(): every query names the caller; there is nothing of anyone else to ask for.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Authenticated()
  @Get()
  list(): Promise<NotificationListResponse> {
    return this.notifications.list();
  }

  @Authenticated()
  @Get('preferences')
  async preferences(): Promise<{ data: NotificationPreference[] }> {
    return { data: await this.notifications.preferences() };
  }

  /** Set-state: the same choices again change nothing. */
  @Authenticated()
  @Idempotent()
  @Put('preferences')
  async putPreferences(
    @Body(new ZodBody(putNotificationPreferencesSchema)) body: PutNotificationPreferences,
  ): Promise<{ data: NotificationPreference[] }> {
    return { data: await this.notifications.putPreferences(body) };
  }

  @Authenticated()
  @Idempotent()
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(): Promise<{ updated: number }> {
    return this.notifications.markAllRead();
  }

  @Authenticated()
  @Idempotent()
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: notificationErrors.notFound })) id: string,
  ): Promise<Notification> {
    return this.notifications.markRead(id);
  }
}
