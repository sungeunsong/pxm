import { Module } from '@nestjs/common';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { DbModule } from '../db/db.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';

@Module({
  imports: [DbModule, ManagementAuditModule, WebhooksModule],
  controllers: [OperationsController],
  providers: [OperationsService],
})
export class OperationsModule {}
