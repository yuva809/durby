import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationDeliveryHandler } from './notification-delivery.handler';
import { NotificationService } from './notification.service';

/** Stored notifications (ADR 0047); global so every module can notify in its own transaction. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationService, NotificationDeliveryHandler],
  exports: [NotificationService],
})
export class NotificationsModule {}
