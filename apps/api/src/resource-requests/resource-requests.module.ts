import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { ScriptLibrariesModule } from '../script-libraries/script-libraries.module';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { ResourceRequestsController } from './resource-requests.controller';
import { ResourceRequestsService } from './resource-requests.service';

@Module({
  imports: [DbModule, CredentialsModule, ScriptLibrariesModule, ManagementAuditModule],
  controllers: [ResourceRequestsController],
  providers: [ResourceRequestsService],
})
export class ResourceRequestsModule {}
