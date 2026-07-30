import { Module } from '@nestjs/common';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { DbModule } from '../db/db.module';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDispatcher } from './webhook-dispatcher';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [DbModule, ManagementAuditModule],
  controllers: [WebhooksController],
  providers: [WebhookDeliveryService, WebhookDispatcher],
  exports: [WebhookDeliveryService],
})
export class WebhooksModule {}
