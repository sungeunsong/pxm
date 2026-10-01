import {
  Module,
  type InjectionToken,
  type ValueProvider,
} from '@nestjs/common';
import { TemplatesController } from '../templates/templates.controller';
import { InstancesController } from '../instances/instances.controller';
import {
  InstanceTasksController,
  TasksController,
} from '../tasks/tasks.controller';
import { TemplatesService } from '../templates/templates.service';
import { InstancesService } from '../instances/instances.service';
import { TasksService } from '../tasks/tasks.service';
import { OutboxService } from '../outbox/outbox.service';
import { ManagementAuditService } from '../audit/management-audit.service';
import { AuthzService } from '../authz/authz.service';
import { WorkflowCompatibilityService } from '../templates/workflow-compatibility.service';
import { WorkflowStartService } from '../templates/workflow-start.service';
import { ToolsController } from '../entry-points/tools.controller';
import { ToolsService } from '../entry-points/tools.service';
import {
  WorkflowInputPresetRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowScheduleRepositoryPort,
} from '../db/ports/db.ports';

const docsOnlyProvider = (provide: InjectionToken): ValueProvider => ({
  provide,
  useValue: {},
});

@Module({
  controllers: [
    TemplatesController,
    InstancesController,
    TasksController,
    InstanceTasksController,
    ToolsController,
  ],
  providers: [
    // 실행 API 호출 흐름(smoke 테스트)이 인스턴스 생성까지 지나가므로 실제 클래스를 둔다. 의존성은 아래 문서용 값이다
    WorkflowStartService,
    ...[
      TemplatesService,
      InstancesService,
      TasksService,
      OutboxService,
      ManagementAuditService,
      AuthzService,
      WorkflowCompatibilityService,
      ToolsService,
      WorkflowInstanceRepositoryPort,
      WorkflowScheduleRepositoryPort,
      WorkflowInputPresetRepositoryPort,
    ].map(docsOnlyProvider),
  ],
})
export class PublicApiDocsModule {}
