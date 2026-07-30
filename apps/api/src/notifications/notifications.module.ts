import { Module } from '@nestjs/common';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { DbModule } from '../db/db.module';
import { TasksModule } from '../tasks/tasks.module';
import { ApprovalNotificationChannel } from './notification-channel';
import { EmailNotificationChannel } from './email-notification.channel';
import { NotificationDispatcher } from './notification.dispatcher';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [DbModule, TasksModule, ManagementAuditModule],
  controllers: [NotificationsController],
  providers: [
    NotificationService,
    NotificationDispatcher,
    EmailNotificationChannel,
    { provide: ApprovalNotificationChannel, useExisting: EmailNotificationChannel },
  ],
})
export class NotificationsModule {}
