import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { DbModule } from '../db/db.module';
import { InstancesModule } from '../instances/instances.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { DbWatchModule } from '../db-watch/db-watch.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { AuthzModule } from '../authz/authz.module';
import { ScriptLibrariesModule } from '../script-libraries/script-libraries.module';
import { PluginsModule } from '../plugins/plugins.module';
import { CommandsModule } from '../commands/commands.module';
import { WorkflowCompatibilityService } from './workflow-compatibility.service';

@Module({
  imports: [DbModule, InstancesModule, SchedulesModule, DbWatchModule, CredentialsModule, ManagementAuditModule, AuthzModule, ScriptLibrariesModule, PluginsModule, CommandsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, WorkflowCompatibilityService],
  exports: [TemplatesService, WorkflowCompatibilityService],
})
export class TemplatesModule {}
