import { Module, type InjectionToken, type ValueProvider } from '@nestjs/common';
import { TemplatesController } from '../templates/templates.controller';
import { InstancesController } from '../instances/instances.controller';
import { InstanceTasksController, TasksController } from '../tasks/tasks.controller';
import { TemplatesService } from '../templates/templates.service';
import { InstancesService } from '../instances/instances.service';
import { TasksService } from '../tasks/tasks.service';
import { OutboxService } from '../outbox/outbox.service';
import { ManagementAuditService } from '../audit/management-audit.service';
import { AuthzService } from '../authz/authz.service';
import {
  WorkflowInputPresetRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowScheduleRepositoryPort,
} from '../db/ports/db.ports';

const docsOnlyProvider = (provide: InjectionToken): ValueProvider => ({ provide, useValue: {} });

@Module({
  controllers: [TemplatesController, InstancesController, TasksController, InstanceTasksController],
  providers: [
    TemplatesService,
    InstancesService,
    TasksService,
    OutboxService,
    ManagementAuditService,
    AuthzService,
    WorkflowInstanceRepositoryPort,
    WorkflowScheduleRepositoryPort,
    WorkflowInputPresetRepositoryPort,
  ].map(docsOnlyProvider),
})
export class PublicApiDocsModule {}
