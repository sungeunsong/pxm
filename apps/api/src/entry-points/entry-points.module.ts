import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthzModule } from '../authz/authz.module';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { TemplatesModule } from '../templates/templates.module';
import { EntryPointsController } from './entry-points.controller';
import { EntryPointsService } from './entry-points.service';

@Module({
  imports: [DbModule, AuthzModule, ManagementAuditModule, TemplatesModule],
  controllers: [EntryPointsController],
  providers: [EntryPointsService],
  exports: [EntryPointsService],
})
export class EntryPointsModule {}
