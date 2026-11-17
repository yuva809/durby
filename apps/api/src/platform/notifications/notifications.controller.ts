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
  type PushConfigResponse,
  type PushStatusResponse,
  type PushSubscriptionBody,
  pushSubscriptionSchema,
  type PutNotificationPreferences,
  putNotificationPreferencesSchema,
  type RemovePushSubscription,
  removePushSubscriptionSchema,
} from '@durby/shared';
import { Authenticated } from '../auth';
import { ZodBody } from '../http';
import { IdempotencyExempt, Idempotent } from '../idempotency';
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

  /** The server's VAPID public key (null: push is off here). */
  @Authenticated()
  @Get('push')
  pushConfig(): PushConfigResponse {
    return this.notifications.pushConfig();
  }

  /** A POST so the endpoint (a capability URL) stays out of URLs and access logs. */
  @Authenticated()
  @IdempotencyExempt('reads only; the endpoint goes in the body to keep it out of logs')
  @Post('push/status')
  @HttpCode(HttpStatus.OK)
  pushStatus(
    @Body(new ZodBody(removePushSubscriptionSchema)) body: RemovePushSubscription,
  ): Promise<PushStatusResponse> {
    return this.notifications.pushStatus(body);
  }

  /** Set-state: the same browser again changes nothing. */
  @Authenticated()
  @Idempotent()
  @Post('push/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  subscribe(@Body(new ZodBody(pushSubscriptionSchema)) body: PushSubscriptionBody): Promise<void> {
    return this.notifications.subscribe(body);
  }

  @Authenticated()
  @Idempotent()
  @Post('push/unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  unsubscribe(
    @Body(new ZodBody(removePushSubscriptionSchema)) body: RemovePushSubscription,
  ): Promise<void> {
    return this.notifications.unsubscribe(body);
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
