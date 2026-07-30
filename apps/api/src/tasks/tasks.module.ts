import { Module } from '@nestjs/common';
import { InstanceTasksController, TasksController } from './tasks.controller';
import { DbModule } from '../db/db.module';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { TasksService } from './tasks.service';
import { ExternalApprovalController } from './external-approval.controller';
import { ExternalApprovalDispatcher } from './external-approval.dispatcher';
import { ExternalApprovalMailer } from './external-approval.mailer';
import { ExternalApprovalService } from './external-approval.service';

@Module({
  imports: [DbModule, ManagementAuditModule],
  controllers: [TasksController, InstanceTasksController, ExternalApprovalController],
  providers: [TasksService, ExternalApprovalService, ExternalApprovalMailer, ExternalApprovalDispatcher],
  exports: [ExternalApprovalMailer],
})
export class TasksModule {}
