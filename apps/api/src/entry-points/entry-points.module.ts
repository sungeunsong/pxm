import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthzModule } from '../authz/authz.module';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { TemplatesModule } from '../templates/templates.module';
import { EntryPointsController } from './entry-points.controller';
import { EntryPointsService } from './entry-points.service';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';
import { InstancesModule } from '../instances/instances.module';

@Module({
  imports: [
    DbModule,
    AuthzModule,
    ManagementAuditModule,
    TemplatesModule,
    InstancesModule,
  ],
  controllers: [EntryPointsController, ToolsController],
  providers: [EntryPointsService, ToolsService],
  exports: [EntryPointsService],
})
export class EntryPointsModule {}
