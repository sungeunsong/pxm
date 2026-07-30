import { Injectable } from '@nestjs/common';
import { ExternalApprovalMailer } from '../tasks/external-approval.mailer';
import { ApprovalNotificationChannel, type ApprovalNotificationMessage } from './notification-channel';

@Injectable()
export class EmailNotificationChannel implements ApprovalNotificationChannel {
  readonly kind = 'email' as const;
  constructor(private readonly mailer: ExternalApprovalMailer) {}
  isConfigured() { return this.mailer.isConfigured(); }
  send(message: ApprovalNotificationMessage) {
    return this.mailer.sendUserApprovalNotification(message);
  }
}
